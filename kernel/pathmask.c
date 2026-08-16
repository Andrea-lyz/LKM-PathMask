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
#include <asm/syscall.h>
#include <asm/unistd.h>

#define PM_LOG_PREFIX "pathmask: "
#define MAX_HIDE_TARGETS 64
#define MAX_DENY_UIDS 1024
#define TARGET_PATHS_LEN 4096
#define TARGET_TEXT_LEN 256
#define UID_LIST_LEN 8192
#define ANDROID_USER_OFFSET 100000u
/*
 * Android isolated UID layout (see frameworks/base android/os/Process.java):
 *
 *   90000 - 98999 : App Zygote isolated UIDs (FIRST/LAST_APP_ZYGOTE_ISOLATED_UID),
 *                   used by services declared with android:useAppZygote="true".
 *                   Each app reserves a slot of NUM_UIDS_PER_APP_ZYGOTE = 100
 *                   UIDs in this range. Both the App Zygote process itself and
 *                   the isolated services it forks live here -- including the
 *                   `zygotePreloadName` callback that runs *before* the
 *                   service is created.
 *   99000 - 99999 : Regular isolated UIDs (FIRST/LAST_ISOLATED_UID), used by
 *                   plain android:isolatedProcess="true" services that do not
 *                   opt into App Zygote.
 *
 * Detectors such as Holmes' "Abnormal Environment (04)" run their native
 * /proc/self/maps + linker integrity probe inside the App Zygote preload
 * callback, on purpose: the process holds an UID in 90000-98999 which most
 * Magisk/Zygisk denylist and unmount-based hide schemes never filter against,
 * so /data/adb/<root>/... is still visible from there. Treating this range
 * as "isolated" too closes that gap when scope_mode=deny is in effect.
 */
#define ANDROID_APP_ZYGOTE_ISOLATED_START 90000u
#define ANDROID_APP_ZYGOTE_ISOLATED_END 98999u
#define ANDROID_ISOLATED_START 99000u
#define ANDROID_ISOLATED_END 99999u

enum pathmask_scope_mode {
	SCOPE_GLOBAL = 0,
	SCOPE_DENY,
	SCOPE_ALLOW,
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
MODULE_PARM_DESC(hide_isolated, "Also hide from Android isolated-process UIDs (90000-98999 App Zygote, 99000-99999 plain isolated) in deny scope");

/*
 * Syscall fallback hooks: 7 kretprobes on the arm64 syscall entry stubs
 * `__arm64_sys_{newfstatat,statx,faccessat,faccessat2,readlinkat,openat,
 * openat2}`. Introduced in v2.2.5/v2.2.7 to cover stat()/access()/
 * readlink()/openat() paths that ThinLTO inlines away from `vfs_getattr`
 * / `inode_permission` on Android GKI 5.15+.
 *
 * The trade-off is that these hooks sit on the hottest path in the
 * kernel: every dlopen/fopen/access/"does this exist" call -- in any
 * process -- executes them. The kretprobe entry+exit trampoline on
 * arm64 adds a small but very measurable overhead per call (hundreds
 * of ns to ~1us on Snapdragon-class SoCs). Detectors that time-
 * fingerprint a tight stat()/access() loop can pick that up. Holmes'
 * "Abnormal Environment (04)" was bisected on real device data to a
 * single syscall: it trips iff `__arm64_sys_faccessat` is hooked,
 * regardless of which other probes are active or whether they actually
 * fire on Holmes' UID. The most plausible explanation is that
 * Holmes uses access(F_OK), which is the cheapest of these syscalls
 * (no perm check, no inode fill), so the trampoline percentage
 * overhead is the most visible. faccessat2 is fine even though it
 * shares the trampoline machinery, because bionic's access() picks
 * faccessat for flag=0 callers, and Holmes apparently hardcodes that.
 *
 * Two knobs control which of the 7 are registered:
 *
 *   syscall_hooks=
 *     Comma-separated allowlist. Tokens are the short syscall names
 *     ("newfstatat", "statx", "faccessat", "faccessat2", "readlinkat",
 *     "openat", "openat2") plus "all" / "none". Empty string falls
 *     through to enable_syscall_hooks for backward compat.
 *     Default: 6-of-7, every probe except faccessat. This is the
 *     observed sweet spot from the bisect: chunqiu / native
 *     anti-cheat scanners use stat/openat (covered), Holmes uses
 *     access(F_OK) timing (not covered, by design).
 *
 *   enable_syscall_hooks=
 *     Legacy boolean kept for backward compatibility with
 *     pre-v2.4 configs and CLI insmod calls. Only consulted when
 *     syscall_hooks is empty; "1" enables all 7 probes, "0"
 *     disables all 7.
 *
 * `inode_permission`, `vfs_getattr`, and `__arm64_sys_getdents64`
 * remain unconditionally hooked because they are not on a detector-
 * friendly hot path.
 */
static bool enable_syscall_hooks;
module_param(enable_syscall_hooks, bool, 0644);
MODULE_PARM_DESC(enable_syscall_hooks,
	"Legacy boolean: 1 = enable all 7 __arm64_sys_* fallback hooks, 0 = none. Only consulted when `syscall_hooks` is empty. Modern callers should use `syscall_hooks=` to pick a subset.");

#define PM_SYSCALL_HOOKS_LEN 256
static char syscall_hooks[PM_SYSCALL_HOOKS_LEN] =
	"newfstatat,statx,faccessat2,readlinkat,openat,openat2";
module_param_string(syscall_hooks, syscall_hooks, sizeof(syscall_hooks), 0644);
MODULE_PARM_DESC(syscall_hooks,
	"Comma-separated subset of __arm64_sys_* fallback probes to register. Tokens: newfstatat,statx,faccessat,faccessat2,readlinkat,openat,openat2 (or 'all' / 'none'). Default omits faccessat because it is the only probe Holmes Abnormal Environment 04 fingerprints via access(F_OK) timing. Empty string falls back to enable_syscall_hooks.");

static char scope_mode[16] = "global";
module_param_string(scope_mode, scope_mode, sizeof(scope_mode), 0644);
MODULE_PARM_DESC(scope_mode, "Hide scope: global, deny, or allow");

enum pathmask_write_op_policy {
	WRITE_OP_PASSTHROUGH = 0,
	WRITE_OP_EACCES,
	WRITE_OP_ENOENT,
};

static char write_op_policy[16] = "passthrough";
module_param_string(write_op_policy, write_op_policy, sizeof(write_op_policy), 0644);
MODULE_PARM_DESC(write_op_policy,
	"write-class syscall policy on hidden targets: passthrough (default, native fs semantics), eacces (syscall-level absent-emulation incl. open(O_CREAT)), enoent (legacy blanket ENOENT)");

static enum pathmask_write_op_policy active_write_policy = WRITE_OP_PASSTHROUGH;

static char deny_uids[UID_LIST_LEN];
module_param_string(deny_uids, deny_uids, sizeof(deny_uids), 0644);
MODULE_PARM_DESC(deny_uids, "Comma-separated scope UIDs: hidden in deny mode, exempt in allow mode");

struct hidden_target {
	dev_t dev;
	unsigned long long ino;
	char path[TARGET_TEXT_LEN];
	/*
	 * False when the inode was not materialised at insmod time
	 * (i_ino == 0, happens on FUSE before the daemon fills the
	 * node). Matching by (ino=0, dev) would hit every not-yet-
	 * materialised inode on that filesystem, so such targets are
	 * hidden via the path-based syscall hooks only.
	 */
	bool inode_ok;
	/*
	 * Shared-storage alias state: when the target lives under a
	 * storage root (/storage/emulated/0 etc.), string matching tries
	 * every discovered root spelling (see pm_storage_roots) instead
	 * of only the configured one, so /sdcard/X and
	 * /storage/emulated/0/X hide identically.
	 */
	bool under_storage;
	size_t storage_suffix_off;
	size_t storage_suffix_len;
};

static struct hidden_target targets[MAX_HIDE_TARGETS];
static unsigned int target_count;

/*
 * Read-only sysfs view of how many target paths the module successfully
 * resolved at insmod time. Exposed at
 * /sys/module/pathmask/parameters/resolved_count so that the WebUI health
 * check can avoid running stat() against the configured paths in global
 * scope (those calls would now be intercepted by our own syscall hooks
 * and falsely reported as "missing"). target_count itself is the source
 * of truth -- module_param_named() simply mirrors it.
 */
module_param_named(resolved_count, target_count, uint, 0444);
MODULE_PARM_DESC(resolved_count,
		 "Number of target paths successfully resolved at load time");

static enum pathmask_scope_mode active_scope = SCOPE_GLOBAL;
static uid_t deny_uid_list[MAX_DENY_UIDS];
static unsigned int deny_uid_count;

/*
 * Android shared storage is reachable through several alias paths
 * (/storage/emulated/0, /sdcard, /storage/self/primary, /mnt/sdcard).
 * The path-string hooks only match the literal spelling an app passes,
 * so a target configured as /storage/emulated/0/X would stay visible
 * via /sdcard/X. At load time we resolve the candidate roots and keep
 * the ones that hit the same (dev, ino) object as the canonical root;
 * targets under a storage root are then matched against every spelling.
 */
#define PM_STORAGE_CANDIDATES 4

static const char *const pm_storage_candidates[PM_STORAGE_CANDIDATES] = {
	"/storage/emulated/0",
	"/storage/self/primary",
	"/sdcard",
	"/mnt/sdcard",
};

static struct pm_storage_root {
	char path[TARGET_TEXT_LEN];
	size_t len;
} pm_storage_roots[PM_STORAGE_CANDIDATES];
static unsigned int pm_storage_root_count;

typedef int (*pm_kern_path_t)(const char *name, unsigned int flags,
			      struct path *path);
typedef void (*pm_path_put_t)(const struct path *path);
typedef int (*pm_close_fd_t)(unsigned int fd);

static pm_kern_path_t pm_kern_path;
static pm_path_put_t pm_path_put;
static pm_close_fd_t pm_close_fd;

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

static int __nocfi pm_invoke_close_fd(unsigned int fd)
{
	if (!pm_close_fd)
		return -ENOSYS;
	return pm_close_fd(fd);
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

	/*
	 * close_fd() is needed by the openat exit hook to release the fd
	 * that the syscall already allocated before we override the return
	 * value to -ENOENT. It's optional: if the symbol is not resolvable
	 * we just don't hook openat at all.
	 */
	if (!pm_close_fd)
		pm_close_fd = (pm_close_fd_t)
			resolve_kernel_symbol_addr("close_fd");

	pr_info(PM_LOG_PREFIX "resolved VFS path helpers via kprobe\n");
	return 0;
}

static inline bool is_target_inode(const struct inode *inode)
{
	unsigned int i;

	if (!inode || !inode->i_sb)
		return false;

	for (i = 0; i < target_count; i++) {
		if (!targets[i].inode_ok)
			continue;
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
		if (!targets[i].inode_ok)
			continue;
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

	if (app_id >= ANDROID_ISOLATED_START && app_id <= ANDROID_ISOLATED_END)
		return true;

	/*
	 * App Zygote isolated services (android:useAppZygote="true") and the
	 * App Zygote process itself (the one that runs the zygotePreloadName
	 * Java callback before fork) hold UIDs in 90000-98999. Detectors that
	 * deliberately probe /proc/self/maps or the linker from inside their
	 * own ZygotePreload land here, not in 99000-99999, so we have to
	 * treat this range as isolated as well.
	 */
	return app_id >= ANDROID_APP_ZYGOTE_ISOLATED_START &&
	       app_id <= ANDROID_APP_ZYGOTE_ISOLATED_END;
}

static inline bool should_hide_for_current(void)
{
	uid_t uid, euid, fsuid;

	if (active_scope == SCOPE_GLOBAL)
		return true;

	uid = __kuid_val(current_uid());
	euid = __kuid_val(current_euid());
	fsuid = __kuid_val(current_fsuid());

	if (active_scope == SCOPE_ALLOW)
		return !(is_denied_uid(uid) || is_denied_uid(euid) ||
			 is_denied_uid(fsuid));

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

	if (!strcmp(scope_mode, "allow")) {
		active_scope = SCOPE_ALLOW;
		return 0;
	}

	pr_err(PM_LOG_PREFIX "unsupported scope_mode=%s\n", scope_mode);
	return -EINVAL;
}

static int parse_write_op_policy(void)
{
	if (!strcmp(write_op_policy, "passthrough")) {
		active_write_policy = WRITE_OP_PASSTHROUGH;
		return 0;
	}

	if (!strcmp(write_op_policy, "eacces")) {
		active_write_policy = WRITE_OP_EACCES;
		return 0;
	}

	if (!strcmp(write_op_policy, "enoent")) {
		active_write_policy = WRITE_OP_ENOENT;
		return 0;
	}

	pr_err(PM_LOG_PREFIX "unsupported write_op_policy=%s\n",
	       write_op_policy);
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
	if (active_scope == SCOPE_ALLOW && !deny_uid_count)
		pr_warn(PM_LOG_PREFIX "scope_mode=allow but allow UID list is empty; all UIDs hidden\n");

	return 0;
}

static void discover_storage_aliases(void)
{
	struct path path;
	dev_t canon_dev = 0;
	unsigned long long canon_ino = 0;
	unsigned int i;

	pm_storage_root_count = 0;

	if (!pm_kern_path || !pm_path_put)
		return;

	for (i = 0; i < ARRAY_SIZE(pm_storage_candidates); i++) {
		struct inode *inode;
		int ret;

		ret = pm_invoke_kern_path(pm_storage_candidates[i],
					  LOOKUP_FOLLOW, &path);
		if (ret)
			continue;

		inode = d_inode(path.dentry);
		if (!inode || !inode->i_sb) {
			pm_invoke_path_put(&path);
			continue;
		}

		if (canon_dev == 0 && canon_ino == 0) {
			canon_dev = inode->i_sb->s_dev;
			canon_ino = inode->i_ino;
		} else if (inode->i_sb->s_dev != canon_dev ||
			   inode->i_ino != canon_ino) {
			pm_invoke_path_put(&path);
			continue;
		}
		pm_invoke_path_put(&path);

		strscpy(pm_storage_roots[pm_storage_root_count].path,
			pm_storage_candidates[i],
			sizeof(pm_storage_roots[pm_storage_root_count].path));
		pm_storage_roots[pm_storage_root_count].len =
			strlen(pm_storage_candidates[i]);
		pm_storage_root_count++;
	}

	if (pm_storage_root_count > 1) {
		pr_info(PM_LOG_PREFIX "%u storage alias root(s) active\n",
			pm_storage_root_count - 1);
	}
}

static int add_target_path(const char *path_name)
{
	struct path path;
	struct inode *inode;
	int ret;
	unsigned int i;

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
	targets[target_count].inode_ok = inode->i_ino != 0;
	strscpy(targets[target_count].path, path_name,
		sizeof(targets[target_count].path));
	targets[target_count].under_storage = false;
	for (i = 0; i < pm_storage_root_count; i++) {
		size_t rlen = pm_storage_roots[i].len;

		if (strncmp(path_name, pm_storage_roots[i].path, rlen) == 0) {
			targets[target_count].under_storage = true;
			targets[target_count].storage_suffix_off = rlen;
			targets[target_count].storage_suffix_len =
				strlen(path_name) - rlen;
			break;
		}
	}
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

/*
 * errno policy for write-class syscalls. inode_permission/vfs_getattr are
 * consulted mid-operation by filesystems (FUSE+BPF does this during
 * mkdir/rename via lookup_one_qstr_excl-style flows), so a blanket -ENOENT
 * override leaks through as the syscall errno: mkdir on a hidden but
 * existing directory reports ENOENT where stock returns EACCES/EEXIST --
 * a deterministic fingerprint. passthrough (default) leaves the return
 * value untouched so the native fs/FUSE policy produces the stock errno;
 * parents of hidden targets are virtually never writable by the probing
 * app, so the native result is the stock one.
 *
 * arm64 only ships the *at variants (no mkdir/rename/link/symlink/rmdir
 * numbers). Kernel threads have no user pt_regs frame; treat them as
 * non-write-class so they keep the legacy behaviour.
 */
static inline bool pm_is_write_class_syscall(void)
{
	int nr;

	if (current->flags & PF_KTHREAD)
		return false;

	nr = syscall_get_nr(current, task_pt_regs(current));
	switch (nr) {
	case __NR_mkdirat:
	case __NR_renameat:
	case __NR_renameat2:
	case __NR_linkat:
	case __NR_symlinkat:
	case __NR_unlinkat:
		return true;
	default:
		return false;
	}
}

static inline void pm_apply_hide_errno(struct pt_regs *regs)
{
	if (pm_is_write_class_syscall()) {
		switch (active_write_policy) {
		case WRITE_OP_PASSTHROUGH:
			return;
		case WRITE_OP_EACCES:
			regs_set_return_value(regs, -EACCES);
			return;
		case WRITE_OP_ENOENT:
			break;
		}
	}

	regs_set_return_value(regs, -ENOENT);
}

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
		pm_apply_hide_errno(regs);
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
		pm_apply_hide_errno(regs);
	return 0;
}

/*
 * Even though `vfs_getattr` and `inode_permission` are EXPORT_SYMBOL on GKI
 * 5.15+ and our kretprobe attaches to them, ThinLTO can still inline copies
 * of them into in-kernel callers (e.g. vfs_statx, link_path_walk). The
 * kallsyms entry remains valid for module use, but no in-kernel call site
 * actually goes through it, so the kretprobe never fires for stat()/statx()
 * /access()/openat()-into-target. Symbol export does not imply inline
 * immunity on LTO kernels.
 *
 * The arm64 syscall entry stubs (`__arm64_sys_*`) are different: they are
 * stored as function pointers in `sys_call_table[]`, so the linker is forced
 * to keep an out-of-line copy at a fixed address. They sit at the very top
 * of the syscall path, before any inlined VFS dispatch. Hooking them gives
 * a guaranteed interception point for the metadata-leaking syscalls.
 *
 * For openat / openat2 we additionally have to release the fd that the
 * syscall body already allocated before we override the return value to
 * -ENOENT. That requires close_fd(), resolved earlier via kprobe.
 */
struct syscall_match_data {
	bool matched;
	bool needs_close;
	long err;
};

static atomic_t pm_syscall_seen = ATOMIC_INIT(0);

/*
 * Alias-aware prefix match for one target. Targets under a shared
 * storage root compare against every discovered root spelling, so
 * /sdcard/X, /storage/self/primary/X and /mnt/sdcard/X all hide like
 * the configured /storage/emulated/0/X. Non-storage targets keep the
 * single literal-prefix rule.
 */
static bool pm_target_prefix_match(const char *p,
				   const struct hidden_target *t)
{
	size_t plen;

	if (t->under_storage) {
		const char *suffix = t->path + t->storage_suffix_off;
		unsigned int i;

		for (i = 0; i < pm_storage_root_count; i++) {
			size_t rlen = pm_storage_roots[i].len;
			char next;

			if (strncmp(p, pm_storage_roots[i].path, rlen))
				continue;
			if (strncmp(p + rlen, suffix, t->storage_suffix_len))
				continue;
			next = p[rlen + t->storage_suffix_len];
			if (!next || next == '/')
				return true;
		}
		return false;
	}

	plen = strlen(t->path);
	if (!plen)
		return false;
	if (strncmp(p, t->path, plen) == 0) {
		char next = p[plen];

		if (!next || next == '/')
			return true;
	}
	return false;
}

static bool sys_path_matches_target(const char *p)
{
	unsigned int i;

	if (!p || p[0] != '/')
		return false;

	for (i = 0; i < target_count; i++) {
		if (pm_target_prefix_match(p, &targets[i]))
			return true;
	}
	return false;
}

/*
 * Shared core: read filename from regs[1], match against targets, return
 * true if this syscall should be turned into -ENOENT. Called by the two
 * thin entry handlers below. We avoid container_of(ri->rp, ...) because
 * `kretprobe_instance` has no portable `rp` field across the 5.10 / 5.15+
 * KMI lines (5.15 introduced an `rph` indirection and `get_kretprobe()`,
 * neither exists on 5.10), so each syscall kind gets its own thin entry
 * handler that just sets `needs_close` correctly.
 */
static bool sys_path_match_user_filename(struct pt_regs *regs)
{
	struct pt_regs *user_regs = (struct pt_regs *)regs->regs[0];
	char buf[TARGET_TEXT_LEN];
	long len;

	if (!user_regs || !should_hide_for_current())
		return false;

	/*
	 * All hooked syscalls share the same prefix:
	 *   sys_xxxat(int dfd, const char __user *filename, ...)
	 * so the user filename pointer always lands in user_regs->regs[1].
	 */
	len = strncpy_from_user(buf, (const char __user *)user_regs->regs[1],
				sizeof(buf));
	if (len <= 0)
		return false;
	buf[sizeof(buf) - 1] = '\0';

	return sys_path_matches_target(buf);
}

static int sys_path_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;

	d->matched = false;
	d->needs_close = false;
	d->err = -ENOENT;

	if (!sys_path_match_user_filename(regs))
		return 0;

	d->matched = true;
	if (atomic_cmpxchg(&pm_syscall_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX
			"syscall path hook fired (first time)\n");
	return 0;
}

static int sys_openat_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;

	d->matched = false;
	d->needs_close = false;
	d->err = -ENOENT;

	/*
	 * For openat we can only fake -ENOENT if we also have a way to
	 * release the fd the syscall body just allocated. Without close_fd
	 * we'd leak; bail out and let the open succeed rather than corrupt
	 * the fd table.
	 */
	if (!pm_close_fd)
		return 0;

	if (!sys_path_match_user_filename(regs))
		return 0;

	d->matched = true;
	d->needs_close = true;

	/*
	 * Under write_op_policy=eacces an open with O_CREAT must present
	 * the absent profile (-EACCES, "create denied on a nonexistent
	 * entry"): on FUSE+redaction storage -ENOENT here is exactly the
	 * signature of an existing-but-hidden object. Plain opens keep
	 * -ENOENT. Flags live in regs[2] for openat.
	 */
	if (active_write_policy == WRITE_OP_EACCES &&
	    (((struct pt_regs *)regs->regs[0])->regs[2] & O_CREAT))
		d->err = -EACCES;

	if (atomic_cmpxchg(&pm_syscall_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX
			"syscall path hook fired (first time)\n");
	return 0;
}

/*
 * openat2 variant of the open hook: same semantics, but the flags are the
 * first u64 of struct open_how pointed to by regs[2]. No first-fire log
 * here; the shared pm_syscall_seen counter covers the family.
 */
static int sys_openat2_entry(struct kretprobe_instance *ri,
			     struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;
	struct pt_regs *user_regs = (struct pt_regs *)regs->regs[0];

	d->matched = false;
	d->needs_close = false;
	d->err = -ENOENT;

	if (!pm_close_fd)
		return 0;

	if (!sys_path_match_user_filename(regs))
		return 0;

	d->matched = true;
	d->needs_close = true;

	if (active_write_policy == WRITE_OP_EACCES && user_regs) {
		u64 how_flags = 0;

		if (!copy_from_user(&how_flags,
				    (const void __user *)user_regs->regs[2],
				    sizeof(how_flags)) &&
		    (how_flags & O_CREAT))
			d->err = -EACCES;
	}

	return 0;
}

static int sys_path_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct syscall_match_data *d = (struct syscall_match_data *)ri->data;
	long ret = (long)regs->regs[0];

	if (!d->matched)
		return 0;

	if (d->needs_close && ret >= 0) {
		/*
		 * The openat body succeeded and ret is the new fd. Close it
		 * before overriding the return value, otherwise the caller
		 * sees -ENOENT but the kernel keeps the fd allocated forever.
		 */
		pm_invoke_close_fd((unsigned int)ret);
	}

	regs_set_return_value(regs, d->err);
	return 0;
}

/*
 * The probe table mirrors a small per-symbol descriptor with its own entry
 * handler so we don't need to pull `struct kretprobe *` out of the live
 * `struct kretprobe_instance` (which would tie us to a specific KMI).
 */
typedef int (*pm_syscall_entry_t)(struct kretprobe_instance *,
				  struct pt_regs *);

static struct pm_syscall_probe {
	const char *symbol;
	const char *short_name;
	pm_syscall_entry_t entry;
	struct kretprobe rp;
	bool registered;
	bool enabled;
} pm_syscall_probes[] = {
	{ .symbol = "__arm64_sys_newfstatat", .short_name = "newfstatat",
	  .entry = sys_path_entry   },
	{ .symbol = "__arm64_sys_statx",      .short_name = "statx",
	  .entry = sys_path_entry   },
	{ .symbol = "__arm64_sys_faccessat",  .short_name = "faccessat",
	  .entry = sys_path_entry   },
	{ .symbol = "__arm64_sys_faccessat2", .short_name = "faccessat2",
	  .entry = sys_path_entry   },
	{ .symbol = "__arm64_sys_readlinkat", .short_name = "readlinkat",
	  .entry = sys_path_entry   },
	{ .symbol = "__arm64_sys_openat",     .short_name = "openat",
	  .entry = sys_openat_entry },
	{ .symbol = "__arm64_sys_openat2",    .short_name = "openat2",
	  .entry = sys_openat2_entry },
};

/*
 * Parse `syscall_hooks=` into per-entry `enabled` flags. Recognised
 * tokens (case-sensitive, surrounding whitespace stripped):
 *
 *   "all"     -> every probe enabled
 *   "none"    -> every probe disabled
 *   shortname -> just that probe enabled (additive)
 *
 * "all" / "none" act as a reset over what came before, so users can
 * write "all,~faccessat"-style expressions as "all" + a follow-up
 * conf-side filter -- but the kernel does not implement the "~"
 * token itself; that's the WebUI's job.
 *
 * When `syscall_hooks` is empty we honour the legacy
 * `enable_syscall_hooks` boolean (1 = all, 0 = none) so older
 * configs keep working unchanged.
 *
 * Returns the number of enabled probes after parsing.
 */
static unsigned int parse_syscall_hooks(void)
{
	char *buf, *cursor, *item;
	unsigned int i, enabled_count = 0;
	bool any_token_seen = false;

	for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
		pm_syscall_probes[i].enabled = false;

	if (!syscall_hooks[0]) {
		/* Legacy path. */
		if (enable_syscall_hooks) {
			for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
				pm_syscall_probes[i].enabled = true;
			return ARRAY_SIZE(pm_syscall_probes);
		}
		return 0;
	}

	buf = kstrdup(syscall_hooks, GFP_KERNEL);
	if (!buf) {
		pr_warn(PM_LOG_PREFIX
			"kstrdup(syscall_hooks) failed, treating as 'none'\n");
		return 0;
	}

	cursor = buf;
	while ((item = strsep(&cursor, ",")) != NULL) {
		item = strim(item);
		if (!*item)
			continue;
		any_token_seen = true;

		if (!strcmp(item, "all")) {
			for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
				pm_syscall_probes[i].enabled = true;
			continue;
		}
		if (!strcmp(item, "none")) {
			for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
				pm_syscall_probes[i].enabled = false;
			continue;
		}

		for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++) {
			if (!strcmp(item, pm_syscall_probes[i].short_name)) {
				pm_syscall_probes[i].enabled = true;
				break;
			}
		}
		if (i == ARRAY_SIZE(pm_syscall_probes))
			pr_warn(PM_LOG_PREFIX
				"unknown syscall_hooks token '%s' (ignored)\n",
				item);
	}

	kfree(buf);

	/*
	 * If the conf had only whitespace tokens, treat that the same as
	 * empty -> fall back to the legacy boolean. Any concrete token
	 * (even an unrecognised one) means the user intended a subset.
	 */
	if (!any_token_seen) {
		if (enable_syscall_hooks) {
			for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
				pm_syscall_probes[i].enabled = true;
			return ARRAY_SIZE(pm_syscall_probes);
		}
		return 0;
	}

	for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++)
		if (pm_syscall_probes[i].enabled)
			enabled_count++;
	return enabled_count;
}

static void register_syscall_hooks(void)
{
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(pm_syscall_probes); i++) {
		struct pm_syscall_probe *p = &pm_syscall_probes[i];
		int ret;

		if (!p->enabled) {
			pr_info(PM_LOG_PREFIX "skip %s (disabled)\n",
				p->symbol);
			continue;
		}

		p->rp.kp.symbol_name = p->symbol;
		p->rp.entry_handler = p->entry;
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

/*
 * Write-class syscall hooks, active only with write_op_policy=eacces.
 * The inode_permission level cannot shape mkdir/rename errno on FUSE+BPF
 * storage: the ENOENT there is produced by Android's native package
 * redaction during lookup and never passes through a permission check we
 * can hook. The syscall entry stubs are the guaranteed interception point
 * (same reasoning as the read-side fallback hooks above), so we rewrite
 * the final errno to make a hidden-but-existing path present the exact
 * profile of a genuinely absent one:
 *
 *   mkdirat / linkat / symlinkat / renameat(dst)  -> -EACCES
 *   unlinkat / renameat(src)                      -> -ENOENT
 */
struct write_syscall_data {
	bool matched;
	long err;
};

static atomic_t pm_write_seen = ATOMIC_INIT(0);

static bool sys_path_match_user_reg(struct pt_regs *regs, unsigned int regno)
{
	struct pt_regs *user_regs = (struct pt_regs *)regs->regs[0];
	char buf[TARGET_TEXT_LEN];
	long len;

	if (!user_regs || !should_hide_for_current())
		return false;

	len = strncpy_from_user(buf,
				(const char __user *)user_regs->regs[regno],
				sizeof(buf));
	if (len <= 0)
		return false;
	buf[sizeof(buf) - 1] = '\0';

	return sys_path_matches_target(buf);
}

static void write_match_log_once(void)
{
	if (atomic_cmpxchg(&pm_write_seen, 0, 1) == 0)
		pr_info(PM_LOG_PREFIX
			"write-class syscall hook fired (first time)\n");
}

static int sys_mkdirat_entry(struct kretprobe_instance *ri,
			     struct pt_regs *regs)
{
	struct write_syscall_data *d = (struct write_syscall_data *)ri->data;

	d->matched = sys_path_match_user_reg(regs, 1);
	d->err = -EACCES;
	if (d->matched)
		write_match_log_once();
	return 0;
}

static int sys_unlinkat_entry(struct kretprobe_instance *ri,
			      struct pt_regs *regs)
{
	struct write_syscall_data *d = (struct write_syscall_data *)ri->data;

	d->matched = sys_path_match_user_reg(regs, 1);
	d->err = -ENOENT;
	if (d->matched)
		write_match_log_once();
	return 0;
}

/*
 * renameat/renameat2/linkat carry two paths: oldpath in regs[1] and
 * newpath in regs[3]. A hidden source means "absent" (-ENOENT); a hidden
 * destination means "not writable" (-EACCES). Source wins when both hit.
 */
static int sys_two_path_entry(struct kretprobe_instance *ri,
			      struct pt_regs *regs)
{
	struct write_syscall_data *d = (struct write_syscall_data *)ri->data;

	d->matched = false;
	d->err = 0;

	if (sys_path_match_user_reg(regs, 1)) {
		d->matched = true;
		d->err = -ENOENT;
	} else if (sys_path_match_user_reg(regs, 3)) {
		d->matched = true;
		d->err = -EACCES;
	}

	if (d->matched)
		write_match_log_once();
	return 0;
}

/*
 * symlinkat(target, newdfd, linkpath): regs[1] is the symlink content
 * string, not a lookup target; the path being created is regs[2].
 */
static int sys_symlinkat_entry(struct kretprobe_instance *ri,
			       struct pt_regs *regs)
{
	struct write_syscall_data *d = (struct write_syscall_data *)ri->data;

	d->matched = sys_path_match_user_reg(regs, 2);
	d->err = -EACCES;
	if (d->matched)
		write_match_log_once();
	return 0;
}

static int sys_write_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct write_syscall_data *d = (struct write_syscall_data *)ri->data;

	if (d->matched)
		regs_set_return_value(regs, d->err);
	return 0;
}

static struct pm_write_probe {
	const char *symbol;
	pm_syscall_entry_t entry;
	struct kretprobe rp;
	bool registered;
} pm_write_probes[] = {
	{ .symbol = "__arm64_sys_mkdirat",   .entry = sys_mkdirat_entry },
	{ .symbol = "__arm64_sys_unlinkat",  .entry = sys_unlinkat_entry },
	{ .symbol = "__arm64_sys_renameat",  .entry = sys_two_path_entry },
	{ .symbol = "__arm64_sys_renameat2", .entry = sys_two_path_entry },
	{ .symbol = "__arm64_sys_linkat",    .entry = sys_two_path_entry },
	{ .symbol = "__arm64_sys_symlinkat", .entry = sys_symlinkat_entry },
};

static void register_write_hooks(void)
{
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(pm_write_probes); i++) {
		struct pm_write_probe *p = &pm_write_probes[i];
		int ret;

		p->rp.kp.symbol_name = p->symbol;
		p->rp.entry_handler = p->entry;
		p->rp.handler = sys_write_exit;
		p->rp.data_size = sizeof(struct write_syscall_data);
		p->rp.maxactive = 40;

		ret = register_kretprobe(&p->rp);
		if (ret) {
			pr_warn(PM_LOG_PREFIX
				"register_kretprobe(%s) failed: %d (skip)\n",
				p->symbol, ret);
			continue;
		}
		p->registered = true;
		pr_info(PM_LOG_PREFIX "hooked %s (write-class)\n",
			p->symbol);
	}
}

static void unregister_write_hooks(void)
{
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(pm_write_probes); i++) {
		struct pm_write_probe *p = &pm_write_probes[i];

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

	ret = parse_write_op_policy();
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

	discover_storage_aliases();

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

	{
		unsigned int wanted = parse_syscall_hooks();

		if (wanted) {
	register_syscall_hooks();

	if (active_write_policy == WRITE_OP_EACCES)
		register_write_hooks();
	else
		pr_info(PM_LOG_PREFIX
			"write-class syscall hooks disabled (write_op_policy=%s)\n",
			write_op_policy);
			pr_info(PM_LOG_PREFIX
				"syscall fallback: %u of %u probe(s) requested\n",
				wanted,
				(unsigned int)ARRAY_SIZE(pm_syscall_probes));
		} else {
			pr_info(PM_LOG_PREFIX
				"syscall fallback: 0 probes (enable_syscall_hooks=%d, syscall_hooks=\"%s\") -- skipping __arm64_sys_* probes\n",
				enable_syscall_hooks, syscall_hooks);
		}
	}

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
		"loaded -- %u target(s) hidden, scope=%s, scope_uid_count=%u hide_isolated=%d enable_syscall_hooks=%d syscall_hooks=\"%s\" write_op_policy=%s\n",
		target_count, scope_mode, deny_uid_count, hide_isolated,
		enable_syscall_hooks, syscall_hooks, write_op_policy);
	return 0;
}

static void __exit pathmask_exit(void)
{
	unregister_kretprobe(&kp_inode_perm);
	unregister_kretprobe(&kp_inode_getattr);
	unregister_syscall_hooks();
	unregister_write_hooks();
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
