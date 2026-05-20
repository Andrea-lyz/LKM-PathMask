// SPDX-License-Identifier: GPL-2.0
/*
 * PathMask - selective path hiding demo for Android arm64 / GKI.
 *
 * The module stores target identities as (dev, inode) pairs and makes matching
 * paths appear absent to selected UIDs or globally. Target resolution uses
 * kprobe-resolved kern_path()/path_put() pointers so the .ko does not import
 * OEM-pruned VFS helper exports directly.
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/kprobes.h>
#include <linux/cred.h>
#include <linux/dcache.h>
#include <linux/err.h>
#include <linux/fs.h>
#include <linux/namei.h>
#include <linux/path.h>
#include <linux/version.h>
#include <linux/dirent.h>
#include <linux/slab.h>
#include <linux/string.h>
#include <linux/uidgid.h>
#include <linux/uaccess.h>

#define PM_LOG_PREFIX "pathmask: "
#define MAX_HIDE_TARGETS 16
#define MAX_DENY_UIDS 128
#define TARGET_PATHS_LEN 2048
#define TARGET_TEXT_LEN 256
#define UID_LIST_LEN 2048
#define ANDROID_USER_OFFSET 100000u
#define ANDROID_ISOLATED_START 99000u
#define ANDROID_ISOLATED_END 99999u

enum pathmask_scope_mode {
	SCOPE_GLOBAL = 0,
	SCOPE_DENY,
};

static char *target_path = "/data/local/tmp/pathmask";
module_param(target_path, charp, 0644);
MODULE_PARM_DESC(target_path, "Legacy single absolute path to hide");

static char target_paths[TARGET_PATHS_LEN];
module_param_string(target_paths, target_paths, sizeof(target_paths), 0644);
MODULE_PARM_DESC(target_paths, "Comma-separated absolute paths to hide");

static bool hide_dirents = true;
module_param(hide_dirents, bool, 0644);
MODULE_PARM_DESC(hide_dirents, "Hide target from getdents64 directory listings");

static bool hide_isolated = true;
module_param(hide_isolated, bool, 0644);
MODULE_PARM_DESC(hide_isolated, "Also hide from Android isolated-process UIDs in deny scope");

static char scope_mode[16] = "global";
module_param_string(scope_mode, scope_mode, sizeof(scope_mode), 0644);
MODULE_PARM_DESC(scope_mode, "Hide scope: global or deny");

static char deny_uids[UID_LIST_LEN];
module_param_string(deny_uids, deny_uids, sizeof(deny_uids), 0644);
MODULE_PARM_DESC(deny_uids, "Comma-separated UIDs hidden from targets");

struct hidden_target {
	dev_t dev;
	unsigned long long ino;
	char path[TARGET_TEXT_LEN];
};

static struct hidden_target targets[MAX_HIDE_TARGETS];
static unsigned int target_count;
static enum pathmask_scope_mode active_scope = SCOPE_GLOBAL;
static uid_t deny_uid_list[MAX_DENY_UIDS];
static unsigned int deny_uid_count;

typedef int (*pm_kern_path_t)(const char *name, unsigned int flags,
			      struct path *path);
typedef void (*pm_path_put_t)(const struct path *path);

static pm_kern_path_t pm_kern_path;
static pm_path_put_t pm_path_put;

/*
 * On Android GKI builds with CONFIG_CFI_CLANG=y the indirect call below
 * would otherwise be checked against the CFI jump table. kprobe gives us
 * the raw function body address (not the jump-table entry), so the call
 * fails CFI verification and the kernel panics silently before pstore
 * can persist the trace. Wrap the indirect calls in __nocfi helpers so
 * only these two sites bypass the type-id check; the rest of the module
 * keeps full CFI coverage.
 */
#ifndef __nocfi
#define __nocfi
#endif

static int __nocfi pm_invoke_kern_path(const char *name, unsigned int flags,
				       struct path *path)
{
	return pm_kern_path(name, flags, path);
}

static void __nocfi pm_invoke_path_put(const struct path *path)
{
	pm_path_put(path);
}

static unsigned long resolve_kernel_symbol_addr(const char *symbol_name)
{
	struct kprobe kp = {
		.symbol_name = symbol_name,
	};
	unsigned long addr;
	int ret;

	ret = register_kprobe(&kp);
	if (ret) {
		pr_warn(PM_LOG_PREFIX "resolve %s failed: %d\n",
			symbol_name, ret);
		return 0;
	}

	addr = (unsigned long)kp.addr;
	unregister_kprobe(&kp);

	if (!addr)
		pr_warn(PM_LOG_PREFIX "resolve %s returned NULL\n",
			symbol_name);

	return addr;
}

static int resolve_path_helpers(void)
{
	if (!pm_kern_path)
		pm_kern_path = (pm_kern_path_t)
			resolve_kernel_symbol_addr("kern_path");
	if (!pm_path_put)
		pm_path_put = (pm_path_put_t)
			resolve_kernel_symbol_addr("path_put");

	if (!pm_kern_path || !pm_path_put)
		return -ENOENT;

	pr_info(PM_LOG_PREFIX "resolved VFS path helpers via kprobe\n");
	return 0;
}

static inline bool is_target_inode(const struct inode *inode)
{
	unsigned int i;

	if (!inode || !inode->i_sb)
		return false;

	for (i = 0; i < target_count; i++) {
		if (inode->i_ino == targets[i].ino &&
		    inode->i_sb->s_dev == targets[i].dev)
			return true;
	}

	return false;
}

static inline bool is_target_ino(__u64 ino)
{
	unsigned int i;

	for (i = 0; i < target_count; i++) {
		if (ino == (__u64)targets[i].ino)
			return true;
	}

	return false;
}

static inline bool is_denied_uid(uid_t uid)
{
	unsigned int i;

	for (i = 0; i < deny_uid_count; i++) {
		if (uid == deny_uid_list[i])
			return true;
	}

	return false;
}

static inline bool is_android_isolated_uid(uid_t uid)
{
	uid_t app_id = uid % ANDROID_USER_OFFSET;

	return app_id >= ANDROID_ISOLATED_START &&
	       app_id <= ANDROID_ISOLATED_END;
}

static inline bool should_hide_for_current(void)
{
	uid_t uid, euid, fsuid;

	if (active_scope == SCOPE_GLOBAL)
		return true;

	uid = __kuid_val(current_uid());
	euid = __kuid_val(current_euid());
	fsuid = __kuid_val(current_fsuid());

	if (hide_isolated &&
	    (is_android_isolated_uid(uid) ||
	     is_android_isolated_uid(euid) ||
	     is_android_isolated_uid(fsuid)))
		return true;

	return is_denied_uid(uid) || is_denied_uid(euid) ||
	       is_denied_uid(fsuid);
}

static int parse_scope_mode(void)
{
	if (!strcmp(scope_mode, "global")) {
		active_scope = SCOPE_GLOBAL;
		return 0;
	}

	if (!strcmp(scope_mode, "deny")) {
		active_scope = SCOPE_DENY;
		return 0;
	}

	pr_err(PM_LOG_PREFIX "unsupported scope_mode=%s\n", scope_mode);
	return -EINVAL;
}

static int add_deny_uid(uid_t uid)
{
	if (deny_uid_count >= MAX_DENY_UIDS) {
		pr_warn(PM_LOG_PREFIX "too many deny UIDs, skip %u\n", uid);
		return -ENOSPC;
	}

	if (is_denied_uid(uid))
		return 0;

	deny_uid_list[deny_uid_count++] = uid;
	pr_info(PM_LOG_PREFIX "deny_uid[%u]=%u\n", deny_uid_count - 1, uid);
	return 0;
}

static int parse_deny_uids(void)
{
	char *buf, *cursor, *item;
	int ret = 0;

	if (!deny_uids[0])
		return 0;

	buf = kstrdup(deny_uids, GFP_KERNEL);
	if (!buf)
		return -ENOMEM;

	cursor = buf;
	while ((item = strsep(&cursor, ",")) != NULL) {
		unsigned int uid;

		item = strim(item);
		if (!*item)
			continue;

		ret = kstrtouint(item, 10, &uid);
		if (ret) {
			pr_warn(PM_LOG_PREFIX "invalid deny uid %s\n", item);
			continue;
		}

		add_deny_uid((uid_t)uid);
	}

	kfree(buf);

	if (active_scope == SCOPE_DENY && !deny_uid_count)
		pr_warn(PM_LOG_PREFIX "scope_mode=deny but deny_uids is empty\n");

	return 0;
}

static int add_target_path(const char *path_name)
{
	struct path path;
	struct inode *inode;
	int ret;

	if (target_count >= MAX_HIDE_TARGETS) {
		pr_warn(PM_LOG_PREFIX "too many targets, skip %s\n", path_name);
		return -ENOSPC;
	}

	if (!pm_kern_path || !pm_path_put)
		return -ENOENT;

	ret = pm_invoke_kern_path(path_name, LOOKUP_FOLLOW, &path);
	if (ret) {
		pr_warn(PM_LOG_PREFIX "%s not found (err=%d), skip\n",
			path_name, ret);
		return ret;
	}

	inode = d_inode(path.dentry);
	if (!inode || !inode->i_sb) {
		pm_invoke_path_put(&path);
		pr_warn(PM_LOG_PREFIX "%s has no inode, skip\n", path_name);
		return -ENOENT;
	}

	targets[target_count].ino = inode->i_ino;
	targets[target_count].dev = inode->i_sb->s_dev;
	strscpy(targets[target_count].path, path_name,
		sizeof(targets[target_count].path));
	pr_info(PM_LOG_PREFIX "target[%u] %s ino=%llu dev=%u:%u\n",
		target_count, path_name, targets[target_count].ino,
		MAJOR(targets[target_count].dev),
		MINOR(targets[target_count].dev));
	target_count++;
	pm_invoke_path_put(&path);

	return 0;
}

static int resolve_target_paths(const char *paths)
{
	char *buf, *cursor, *item;
	int ret = -ENOENT;

	buf = kstrdup(paths, GFP_KERNEL);
	if (!buf)
		return -ENOMEM;

	cursor = buf;
	while ((item = strsep(&cursor, ",")) != NULL) {
		item = strim(item);
		if (!*item)
			continue;

		ret = add_target_path(item);
		if (ret && target_count == 0)
			continue;
	}

	kfree(buf);

	if (!target_count)
		return ret;

	return 0;
}

static struct kretprobe kp_inode_perm;
static atomic_t pm_perm_seen = ATOMIC_INIT(0);
static atomic_t pm_getattr_seen = ATOMIC_INIT(0);

struct inode_perm_data {
	unsigned long matched;
};

/*
 * Hook inode_permission rather than security_inode_permission. The latter is
 * a tiny LSM dispatcher that ThinLTO inlines into its callers on Android GKI
 * 5.15+, leaving the exported symbol live in kallsyms but never actually
 * called -- the kretprobe would attach but never fire.
 *
 * inode_permission's signature differs across kernel versions:
 *   < 5.12: int inode_permission(struct inode *, int)
 *   5.12+:  int inode_permission(struct user_namespace *, struct inode *, int)
 *   6.3+:   int inode_permission(struct mnt_idmap *, struct inode *, int)
 * which shifts the inode argument from x0 to x1 starting with 5.12.
 */
#if LINUX_VERSION_CODE >= KERNEL_VERSION(5, 12, 0)
#define PM_PERM_INODE_REG 1
#else
#define PM_PERM_INODE_REG 0
#endif

static int perm_inode_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct inode_perm_data *d = (struct inode_perm_data *)ri->data;
	struct inode *inode = (struct inode *)regs->regs[PM_PERM_INODE_REG];

	if (atomic_cmpxchg(&pm_perm_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX "inode_permission hook fired (first time)\n");

	d->matched = should_hide_for_current() && is_target_inode(inode);
	return 0;
}

static int perm_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct inode_perm_data *d = (struct inode_perm_data *)ri->data;

	if (d->matched)
		regs_set_return_value(regs, -ENOENT);
	return 0;
}

static struct kretprobe kp_inode_getattr;

/*
 * Same reasoning as the perm hook: security_inode_getattr is a tiny LSM
 * dispatcher inlined by ThinLTO. vfs_getattr is the actual VFS entry point,
 * exported and large enough that it stays out-of-line. Both functions take
 * `const struct path *` as the first argument, so the entry handler is
 * unchanged.
 */
static int getattr_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct inode_perm_data *d = (struct inode_perm_data *)ri->data;
	struct path *path = (struct path *)regs->regs[0];
	struct inode *inode = NULL;

	if (atomic_cmpxchg(&pm_getattr_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX "vfs_getattr hook fired (first time)\n");

	if (path && path->dentry)
		inode = d_inode(path->dentry);

	d->matched = should_hide_for_current() && is_target_inode(inode);
	return 0;
}

static int getattr_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct inode_perm_data *d = (struct inode_perm_data *)ri->data;

	if (d->matched)
		regs_set_return_value(regs, -ENOENT);
	return 0;
}

/*
 * Even though `vfs_getattr` and `inode_permission` are EXPORT_SYMBOL on GKI
 * 5.15+ and our kretprobe attaches to them, ThinLTO can still inline copies
 * of them into in-kernel callers (e.g. vfs_statx). The kallsyms entry remains
 * valid for module use, but no in-kernel call site actually goes through it,
 * so the kretprobe never fires for stat()/statx()/access(). Symbol export
 * does not imply inline immunity on LTO kernels.
 *
 * The arm64 syscall entry stubs (`__arm64_sys_*`) are different: they are
 * stored as function pointers in `sys_call_table[]`, so the linker is forced
 * to keep an out-of-line copy at a fixed address. They sit at the very top
 * of the syscall path, before any inlined VFS dispatch. Hooking them gives
 * a guaranteed interception point for the metadata-leaking syscalls.
 *
 * We deliberately do NOT hook `__arm64_sys_openat` here: kretprobe runs at
 * function exit, by which point a successful openat() has already allocated
 * an fd in the caller's table. Overriding the return value to -ENOENT would
 * leak that fd. openat() is left to the existing `inode_permission` hook,
 * which fires during path walk before the file table is touched.
 */
struct syscall_match_data {
	bool matched;
};

static struct pm_syscall_probe {
	const char *symbol;
	struct kretprobe rp;
	bool registered;
} pm_syscall_probes[] = {
	{ .symbol = "__arm64_sys_newfstatat" },
	{ .symbol = "__arm64_sys_statx" },
	{ .symbol = "__arm64_sys_faccessat" },
	{ .symbol = "__arm64_sys_faccessat2" },
	{ .symbol = "__arm64_sys_readlinkat" },
};

static atomic_t pm_syscall_seen = ATOMIC_INIT(0);

static bool sys_path_matches_target(const char *p)
{
	unsigned int i;

	if (!p || p[0] != '/')
		return false;

	for (i = 0; i < target_count; i++) {
		size_t plen = strlen(targets[i].path);

		if (!plen)
			continue;
		if (strncmp(p, targets[i].path, plen) == 0) {
			char next = p[plen];

			if (next == '\0' || next == '/')
				return true;
		}
	}
	return false;
}

static int sys_path_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;
	struct pt_regs *user_regs = (struct pt_regs *)regs->regs[0];
	char buf[TARGET_TEXT_LEN];
	long len;

	d->matched = false;

	if (!user_regs || !should_hide_for_current())
		return 0;

	/*
	 * All hooked syscalls share the same prefix:
	 *   sys_xxxat(int dfd, const char __user *filename, ...)
	 * so the user filename pointer always lands in user_regs->regs[1].
	 */
	len = strncpy_from_user(buf, (const char __user *)user_regs->regs[1],
				sizeof(buf));
	if (len <= 0)
		return 0;
	buf[sizeof(buf) - 1] = '\0';

	if (!sys_path_matches_target(buf))
		return 0;

	d->matched = true;
	if (atomic_cmpxchg(&pm_syscall_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX
			"syscall path hook fired (first time)\n");
	return 0;
}

static int sys_path_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;

	if (d->matched)
		regs_set_return_value(regs, -ENOENT);
	return 0;
}

static void register_syscall_hooks(void)
{
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++) {
		struct pm_syscall_probe *p = &pm_syscall_probes[i];
		int ret;

		p->rp.kp.symbol_name = p->symbol;
		p->rp.entry_handler = sys_path_entry;
		p->rp.handler = sys_path_exit;
		p->rp.data_size = sizeof(struct syscall_match_data);
		p->rp.maxactive = 40;

		ret = register_kretprobe(&p->rp);
		if (ret) {
			/*
			 * Some older kernels lack faccessat2 etc. Tolerate
			 * per-symbol failure: keep the rest of the syscall
			 * hooks active and just log the missing one.
			 */
			pr_warn(PM_LOG_PREFIX
				"register_kretprobe(%s) failed: %d (skip)\n",
				p->symbol, ret);
			continue;
		}
		p->registered = true;
		pr_info(PM_LOG_PREFIX "hooked %s\n", p->symbol);
	}
}

static void unregister_syscall_hooks(void)
{
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++) {
		struct pm_syscall_probe *p = &pm_syscall_probes[i];

		if (p->registered) {
			unregister_kretprobe(&p->rp);
			p->registered = false;
		}
	}
}

#define GETDENTS_BUF_LIMIT 65536u

static struct kretprobe kp_getdents;
static bool getdents_registered;

struct getdents_cb_data {
	struct linux_dirent64 __user *dirent;
	void *kbuf;
	size_t kbuf_len;
	bool scoped;
};

static int getdents_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct getdents_cb_data *d = (struct getdents_cb_data *)ri->data;
	struct pt_regs *user_regs = (struct pt_regs *)regs->regs[0];
	unsigned int count;

	d->dirent = NULL;
	d->kbuf = NULL;
	d->kbuf_len = 0;
	d->scoped = should_hide_for_current();

	if (!d->scoped || !user_regs)
		return 0;

	count = (unsigned int)user_regs->regs[2];
	d->dirent = (struct linux_dirent64 __user *)user_regs->regs[1];

	count = min(count, GETDENTS_BUF_LIMIT);
	if (!count)
		return 0;

	d->kbuf = kmalloc(count, GFP_KERNEL);
	if (d->kbuf)
		d->kbuf_len = count;
	return 0;
}

static int getdents_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct getdents_cb_data *d = (struct getdents_cb_data *)ri->data;
	long ret = regs->regs[0];
	struct linux_dirent64 *kbuf, *prev, *cur;
	long bpos, new_len;
	const size_t hdr_off = offsetof(struct linux_dirent64, d_name);
	const size_t min_reclen = offsetof(struct linux_dirent64, d_name) + 1;
	bool modified = false;

	if (ret <= 0 || !d->scoped || !d->dirent || !d->kbuf)
		goto out;

	if ((size_t)ret > d->kbuf_len) {
		pr_debug_ratelimited(PM_LOG_PREFIX
				     "getdents return too large (%ld > %zu), skip filtering\n",
				     ret, d->kbuf_len);
		goto out;
	}

	if (copy_from_user(d->kbuf, d->dirent, ret))
		goto out;

	kbuf = d->kbuf;
	prev = NULL;
	bpos = 0;
	new_len = ret;

	while (bpos + (long)hdr_off < new_len) {
		unsigned short reclen;

		cur = (struct linux_dirent64 *)((char *)kbuf + bpos);
		reclen = cur->d_reclen;

		if (reclen < min_reclen || reclen > new_len - bpos)
			break;

		if (is_target_ino(cur->d_ino)) {
			modified = true;
			if (prev) {
				if ((unsigned int)prev->d_reclen + reclen <=
				    65535u) {
					prev->d_reclen += reclen;
					bpos += reclen;
					continue;
				}
			}

			new_len -= reclen;
			if (new_len > bpos)
				memmove(cur, (char *)cur + reclen,
					new_len - bpos);
			continue;
		}

		prev = cur;
		bpos += reclen;
	}

	if (modified) {
		if (copy_to_user(d->dirent, kbuf, new_len))
			pr_warn_ratelimited(PM_LOG_PREFIX
					    "copy_to_user failed, directory may leak\n");
		else
			regs->regs[0] = new_len;
	}

out:
	kfree(d->kbuf);
	d->kbuf = NULL;
	d->kbuf_len = 0;
	return 0;
}

static int __init pathmask_init(void)
{
	const char *paths = target_paths[0] ? target_paths : target_path;
	int ret;

	ret = parse_scope_mode();
	if (ret)
		return ret;

	ret = parse_deny_uids();
	if (ret)
		return ret;

	ret = resolve_path_helpers();
	if (ret) {
		pr_err(PM_LOG_PREFIX "could not resolve VFS path helpers (err=%d)\n",
		       ret);
		return ret;
	}

	ret = resolve_target_paths(paths);
	if (ret) {
		pr_err(PM_LOG_PREFIX "no valid targets (err=%d)\n", ret);
		return ret;
	}

	kp_inode_perm.kp.symbol_name = "inode_permission";
	kp_inode_perm.entry_handler = perm_inode_entry;
	kp_inode_perm.handler = perm_exit;
	kp_inode_perm.data_size = sizeof(struct inode_perm_data);
	kp_inode_perm.maxactive = 40;
	ret = register_kretprobe(&kp_inode_perm);
	if (ret) {
		pr_err(PM_LOG_PREFIX
		       "register_kretprobe(inode_permission) failed: %d\n",
		       ret);
		return ret;
	}
	pr_info(PM_LOG_PREFIX "hooked inode_permission\n");

	kp_inode_getattr.kp.symbol_name = "vfs_getattr";
	kp_inode_getattr.entry_handler = getattr_entry;
	kp_inode_getattr.handler = getattr_exit;
	kp_inode_getattr.data_size = sizeof(struct inode_perm_data);
	kp_inode_getattr.maxactive = 40;
	ret = register_kretprobe(&kp_inode_getattr);
	if (ret) {
		pr_err(PM_LOG_PREFIX
		       "register_kretprobe(vfs_getattr) failed: %d\n",
		       ret);
		unregister_kretprobe(&kp_inode_perm);
		return ret;
	}
	pr_info(PM_LOG_PREFIX "hooked vfs_getattr\n");

	register_syscall_hooks();

	if (hide_dirents) {
		kp_getdents.kp.symbol_name = "__arm64_sys_getdents64";
		kp_getdents.entry_handler = getdents_entry;
		kp_getdents.handler = getdents_exit;
		kp_getdents.data_size = sizeof(struct getdents_cb_data);
		kp_getdents.maxactive = 20;
		ret = register_kretprobe(&kp_getdents);
		if (ret) {
			pr_warn(PM_LOG_PREFIX
				"register_kretprobe(__arm64_sys_getdents64) failed: %d; listings may leak\n",
				ret);
		} else {
			getdents_registered = true;
			pr_info(PM_LOG_PREFIX "hooked __arm64_sys_getdents64\n");
		}
	} else {
		pr_info(PM_LOG_PREFIX
			"hide_dirents=0, directory listings are not filtered\n");
	}

	pr_info(PM_LOG_PREFIX
		"loaded -- %u target(s) hidden, scope=%s, deny_uid_count=%u hide_isolated=%d\n",
		target_count, scope_mode, deny_uid_count, hide_isolated);
	return 0;
}

static void __exit pathmask_exit(void)
{
	unregister_kretprobe(&kp_inode_perm);
	unregister_kretprobe(&kp_inode_getattr);
	unregister_syscall_hooks();
	if (getdents_registered) {
		unregister_kretprobe(&kp_getdents);
		getdents_registered = false;
	}

	pr_info(PM_LOG_PREFIX "unloaded -- %u target(s) visible again\n",
		target_count);
}

module_init(pathmask_init);
module_exit(pathmask_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Andrea-lyz");
MODULE_DESCRIPTION("Selective path masking demo via kretprobes");
