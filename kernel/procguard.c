// SPDX-License-Identifier: GPL-2.0
/*
 * procguard - neutralize the AID_READPROC (gid 3009) /proc bypass for
 * Android isolated processes.
 *
 * Background (LSPosed/Privisolated disclosure, 2026-08):
 *
 * Android's zygote is started by init with supplementary group "readproc"
 * (init.zygote*.rc: `group root readproc`), i.e. gid 3009. /proc is mounted
 * with hidepid=2,gid=3009, so membership in that group lets a process
 * enumerate and read /proc/<pid> entries of every process on the system.
 *
 * When zygote forks a regular app, system_server sends an explicit gid list
 * and setgroups() replaces the inherited groups, dropping 3009. When it
 * forks a child/app zygote, SpecializeCommon() clears the groups explicitly
 * (SetGids() in core/jni/com_android_internal_os_Zygote.cpp calls
 * setgroups(0, NULL) for an empty gid list when is_child_zygote is true --
 * that is the old Project Zero fix). But for plain isolated processes
 * (android:isolatedProcess="true") system_server sends no gid list at all
 * and is_child_zygote is false, so setgroups() is never called and the
 * isolated process inherits gid 3009 straight from zygote. Any app can then
 * walk the whole process table from its most restricted process and read
 * /proc/<pid>/mountinfo, cmdline, maps, ... of every process, which defeats
 * Magisk/KSU style mount hiding.
 *
 * Instead of patching the framework (needs a ROM build/OTA), this module
 * intercepts in_group_p() and forces a "not a member" result whenever an
 * isolated-UID caller asks about the configured target gid (3009 by
 * default). The procfs hidepid gate (has_pid_permissions() in
 * fs/proc/base.c) then falls back to ptrace_may_access(), which only allows
 * same-task access: the isolated process keeps /proc/self/* but sees
 * nothing else. gid 3009 exists exclusively for the procfs readproc gate on
 * Android, so nothing legitimate is lost for these UIDs.
 *
 * Hook choice: in_group_p() is EXPORT_SYMBOL and therefore guaranteed to
 * exist out-of-line even on ThinLTO GKI kernels. The more targeted static
 * helper has_pid_permissions() is at risk of being inlined into its callers
 * (the same ThinLTO failure mode documented in pathmask.c): a kprobe on it
 * would attach successfully and then never fire.
 *
 * Overhead note: in_group_p() is called on every /proc/<pid> permission
 * check and from a few other in-kernel users. The kretprobe trampoline
 * adds a small cost per call; monitor pg_probe.nmissed via the
 * /sys/module/procguard/parameters/missed counter if suspicious.
 *
 * arm64 only: argument/return handling assumes the arm64 ABI.
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/kprobes.h>
#include <linux/cred.h>
#include <linux/uidgid.h>
#include <linux/atomic.h>
#include <asm/ptrace.h>

#define PG_LOG_PREFIX "procguard: "

/*
 * Android isolated UID layout in app-id space (uid % 100000), see
 * frameworks/base android/os/Process.java and pathmask.c:
 *
 *   90000 - 98999 : App Zygote isolated UIDs (the app zygote itself and the
 *                   isolated services it forks, android:useAppZygote="true")
 *   99000 - 99999 : Regular isolated UIDs forked from the main zygote
 *                   (android:isolatedProcess="true") -- these inherit
 *                   gid 3009 from zygote today.
 *
 * We cover the whole 90000-99999 span: even where child zygotes already get
 * empty groups from the framework, forcing the readproc gate closed for the
 * full isolated range is harmless and closes OEM forks that do not.
 */
#define ANDROID_USER_OFFSET 100000u
#define ANDROID_APP_ZYGOTE_ISOLATED_START 90000u
#define ANDROID_APP_ZYGOTE_ISOLATED_END 98999u
#define ANDROID_ISOLATED_START 99000u
#define ANDROID_ISOLATED_END 99999u

static unsigned int target_gid = 3009;
module_param(target_gid, uint, 0644);
MODULE_PARM_DESC(target_gid,
	"GID whose membership is neutralized for isolated UIDs (default 3009 = AID_READPROC)");

static bool block_isolated = true;
module_param(block_isolated, bool, 0644);
MODULE_PARM_DESC(block_isolated,
	"1 = neutralize target_gid for isolated UIDs (hot-toggleable without rmmod)");

static atomic64_t pg_blocked_hits = ATOMIC64_INIT(0);
static atomic_t pg_seen = ATOMIC_INIT(0);

static struct kretprobe pg_probe;

static int pg_hits_get(char *buf, const struct kernel_param *kp)
{
	return sprintf(buf, "%lld\n",
		       (long long)atomic64_read(&pg_blocked_hits));
}

static const struct kernel_param_ops pg_hits_ops = {
	.get = pg_hits_get,
};
module_param_cb(blocked_hits, &pg_hits_ops, NULL, 0444);
MODULE_PARM_DESC(blocked_hits, "Number of in_group_p() results overridden so far");

static int pg_missed_get(char *buf, const struct kernel_param *kp)
{
	return sprintf(buf, "%u\n", pg_probe.nmissed);
}

static const struct kernel_param_ops pg_missed_ops = {
	.get = pg_missed_get,
};
module_param_cb(missed, &pg_missed_ops, NULL, 0444);
MODULE_PARM_DESC(missed, "kretprobe instances dropped due to maxactive exhaustion");

struct pg_probe_data {
	bool matched;
};

static inline bool pg_is_isolated_app_id(uid_t uid)
{
	uid_t app_id = uid % ANDROID_USER_OFFSET;

	return (app_id >= ANDROID_APP_ZYGOTE_ISOLATED_START &&
		app_id <= ANDROID_APP_ZYGOTE_ISOLATED_END) ||
	       (app_id >= ANDROID_ISOLATED_START &&
		app_id <= ANDROID_ISOLATED_END);
}

static inline bool pg_isolated_caller(void)
{
	return pg_is_isolated_app_id(__kuid_val(current_uid())) ||
	       pg_is_isolated_app_id(__kuid_val(current_euid())) ||
	       pg_is_isolated_app_id(__kuid_val(current_fsuid()));
}

static int pg_entry(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct pg_probe_data *d = (struct pg_probe_data *)ri->data;

	d->matched = false;

	if (!block_isolated)
		return 0;

	if (atomic_cmpxchg(&pg_seen, 0, 1) == 0)
		pr_info(PG_LOG_PREFIX "in_group_p hook fired (first time)\n");

	/* arm64 ABI: kgid_t (single u32) is passed by value in w0. */
	if ((gid_t)(u32)regs->regs[0] == (gid_t)target_gid &&
	    pg_isolated_caller())
		d->matched = true;

	return 0;
}

static int pg_exit(struct kretprobe_instance *ri, struct pt_regs *regs)
{
	struct pg_probe_data *d = (struct pg_probe_data *)ri->data;

	if (d->matched) {
		regs_set_return_value(regs, 0);
		atomic64_inc(&pg_blocked_hits);
	}

	return 0;
}

static struct kretprobe pg_probe = {
	.entry_handler = pg_entry,
	.handler = pg_exit,
	.data_size = sizeof(struct pg_probe_data),
	.maxactive = 128,
	.kp.symbol_name = "in_group_p",
};

static int __init procguard_init(void)
{
	int ret;

	if (!target_gid || target_gid > 65535u) {
		pr_err(PG_LOG_PREFIX "invalid target_gid=%u\n", target_gid);
		return -EINVAL;
	}

	ret = register_kretprobe(&pg_probe);
	if (ret) {
		pr_err(PG_LOG_PREFIX
		       "register_kretprobe(in_group_p) failed: %d\n", ret);
		return ret;
	}

	pr_info(PG_LOG_PREFIX
		"loaded: neutralizing gid %u for isolated UIDs 90000-99999 (block_isolated=%d)\n",
		target_gid, block_isolated);
	return 0;
}

static void __exit procguard_exit(void)
{
	unregister_kretprobe(&pg_probe);
	pr_info(PG_LOG_PREFIX "unloaded: blocked_hits=%lld missed=%u\n",
		(long long)atomic64_read(&pg_blocked_hits), pg_probe.nmissed);
}

module_init(procguard_init);
module_exit(procguard_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Neutralize AID_READPROC (gid 3009) for Android isolated UIDs");
