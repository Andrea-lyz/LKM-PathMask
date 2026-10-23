// Set up a global error trap before anything else. If app.js fails to
// parse or any top-level statement throws synchronously, the WebUI
// would otherwise stay frozen on the HTML default status text with
// no clue what went wrong (the bottom-of-file try/catch can't catch
// errors thrown above it). This handler writes the error directly
// into #statusText so we can debug from the WebUI alone, without
// needing chrome://inspect to be reachable.
window.addEventListener("error", (event) => {
	const msg = event && event.message ? event.message : t("未知错误");
	const where = event && event.filename
		? `${event.filename}:${event.lineno}:${event.colno}`
		: "";
	const status = document.getElementById("statusText");
	if (status) {
		status.textContent = t(`脚本错误：{0} {1}`, [msg, where]);
		status.classList.add("statusError");
	}
});
window.addEventListener("unhandledrejection", (event) => {
	const reason = event && event.reason;
	const msg = reason && reason.message ? reason.message
		: typeof reason === "string" ? reason : String(reason);
	const status = document.getElementById("statusText");
	if (status) {
		status.textContent = t(`Promise 错误：{0}`, [msg]);
		status.classList.add("statusError");
	}
});

const MODULE_ID = "pathmask";
const LEGACY_MODULE_ID = "nohello-demo";
const MODULE_NAME = "pathmask";
const LEGACY_MODULE_NAME = "nohello";
const PROCGUARD_MODULE_NAME = "procguard";
const MODDIR = `/data/adb/modules/${MODULE_ID}`;
const LEGACY_MODDIR = `/data/adb/modules/${LEGACY_MODULE_ID}`;
const CONFIGDIR = "/data/adb/pathmask";
const LEGACY_CONFIGDIR = "/data/adb/nohello";
const LOG_PAGE_LINES = 80;

const DEFAULT_TARGET_PATHS = [
	"/dev/cpuset/scene-daemon",
	"dir:/dev/???/scene_mode_category",
	"/system_ext/app/SoterService",
];

const DEFAULT_DENY_PACKAGES = [
	"com.chunqiunativecheck",
	"com.eltavine.duckdetector",
	"luna.safe.luna",
];

// Recommended subset of __arm64_sys_* fallback hooks. faccessat is
// intentionally excluded: bisect data on real devices showed Holmes
// "Abnormal Environment 04" trips iff faccessat is hooked, regardless
// of whether the probe ever actually fires for Holmes' UID. Most
// sane callers go through faccessat2 / openat / newfstatat anyway,
// so leaving faccessat off costs almost nothing in coverage. See
// MODULE_PARM_DESC(syscall_hooks) and the kernel-side comment for
// the reasoning chain.
const ALL_SYSCALL_HOOKS = [
	"newfstatat",
	"statx",
	"faccessat",
	"faccessat2",
	"readlinkat",
	"openat",
	"openat2",
];
const DEFAULT_SYSCALL_HOOKS = ALL_SYSCALL_HOOKS.filter(
	(name) => name !== "faccessat",
);
const SYSCALL_HOOK_SET = new Set(ALL_SYSCALL_HOOKS);
const DEFAULT_ALLOW_SYSTEM_UIDS = ["0", "1000", "2000"];
const ALLOW_SYSTEM_UID_SET = new Set(DEFAULT_ALLOW_SYSTEM_UIDS);

const DEFAULT_WAIT_SECONDS = 60;
const DEFAULT_AUTO_SCENE_DEBUGFS = false;
const BOOT_POLL_INTERVAL_MS = 5000;
const BOOT_WAITING_STATES = new Set(["init", "waiting-targets", "waiting-packages"]);
const SCENE_BACKGROUND_STATES = new Set(["late-watching", "late-found-pending", "late-reload-retry"]);

const files = {
	targets: `${CONFIGDIR}/target_path.conf`,
	hideDirents: `${CONFIGDIR}/hide_dirents.conf`,
	scope: `${CONFIGDIR}/scope_mode.conf`,
	denyPackages: `${CONFIGDIR}/deny_packages.conf`,
	denyUids: `${CONFIGDIR}/deny_uids.conf`,
	allowPackages: `${CONFIGDIR}/allow_packages.conf`,
	allowUids: `${CONFIGDIR}/allow_uids.conf`,
	allowSystemUids: `${CONFIGDIR}/allow_system_uids.conf`,
	waitSeconds: `${CONFIGDIR}/wait_seconds.conf`,
	enableSyscallHooks: `${CONFIGDIR}/enable_syscall_hooks.conf`,
	syscallHooks: `${CONFIGDIR}/syscall_hooks.conf`,
	autoSceneDebugfs: `${CONFIGDIR}/auto_scene_debugfs.conf`,
	sceneDebugfsPaths: `${CONFIGDIR}/scene_debugfs_paths`,
	sceneDebugfsState: `${CONFIGDIR}/scene_debugfs_state`,
	sceneDebugfsWatchStop: `${CONFIGDIR}/scene_debugfs_watch.stop`,
	bootState: `${CONFIGDIR}/boot_state`,
	failCount: `${CONFIGDIR}/load_fail_count`,
	failReason: `${CONFIGDIR}/load_fail_reason`,
	service: `${MODDIR}/service.sh`,
	ko: `${MODDIR}/pathmask.ko`,
	procguardKo: `${MODDIR}/procguard.ko`,
	procguardConf: `${CONFIGDIR}/procguard.conf`,
	writeOpPolicy: `${CONFIGDIR}/write_op_policy.conf`,
};

let apps = [];
let packageSelections = { deny: new Set(), allow: new Set() };
let selectedPackages = packageSelections.deny;
let uidTexts = { deny: "", allow: "" };
let activeListMode = "deny";
let busy = false;
let lastSnapshot = {};
let logPages = { status: [], config: [], kernel: [], script: [] };
let activeLog = "status";
let activeLogPage = 0;
let lastReport = "";
let lastValidation = { errors: [], warnings: [], ok: [] };
let bootPollHandle = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pathList = $("#pathList");
const appList = $("#appList");
const statusText = $("#statusText");
const toast = $("#toast");

/* ------------------------------------------------------------------
 * UI language (Simplified Chinese / English)
 *
 * The Simplified Chinese text in the markup and in the literals below
 * doubles as the translation key: EN_TEXT maps each Chinese source
 * string to its English wording, and t() returns the source unchanged
 * when an entry is missing. That keeps the Chinese build byte-identical
 * in behaviour, lets an unfinished translation degrade to Chinese
 * instead of showing empty labels, and keeps the gaps easy to find:
 * whatever still greps out of the markup and the literals in Chinese but
 * has no EN_TEXT entry is simply not translated yet.
 *
 * Static nodes opt in with data-i18n (text), data-i18n-lead (only the
 * leading text node of a label that is followed by a hint), data-i18n-html
 * (innerHTML for hints that embed <code>/<strong>) and data-i18n-title /
 * data-i18n-aria-label / data-i18n-placeholder / data-i18n-alt
 * (attributes). Everything
 * else is translated where the string is produced, through t().
 *
 * Placeholders written as {name} — or as {0}, {1} … when t() is called
 * with an array — are substituted from t()'s second argument in both
 * languages, so the Chinese rendering is unchanged as well.
 * ------------------------------------------------------------------ */

const UI_LANG_KEY = "pathmask.uiLang";
const UI_LANGS = ["zh", "en"];

const EN_TEXT = {
	// Top bar / navigation shell.
	"捐赠": "Donate",
	"刷新": "Refresh",
	"打开 GitHub 项目": "Open the GitHub project",
	"正在读取状态...": "Reading status...",
	"页面": "Pages",
	"界面语言": "Interface language",
	"中文界面": "Chinese interface",
	"遮罩": "Mask",
	"防护": "Guard",
	"诊断": "Health",
	"日志": "Logs",
	"报告": "Report",
	"保存配置": "Save config",
	"暂停隐藏": "Pause hiding",
	"保存并热重载": "Save & reload",

	// Status summary cards.
	"模块状态": "Module",
	"作用模式": "Scope",
	"隐藏路径": "Hidden paths",
	"作用 UID": "Target UIDs",
	"白名单 UID": "Allowlist UIDs",
	"黑名单 UID": "Denylist UIDs",
	"未知": "Unknown",
	"已加载": "Loaded",
	"旧模块已加载": "Legacy module loaded",
	"未加载": "Not loaded",

	// Scope presets.
	"全局": "Global",
	"白名单": "Allowlist",
	"黑名单": "Denylist",

	// Path rows.
	"组": "Group",
	"删": "Del",
	"可选 OR 组名。同名组内任一行命中即视为该组满足，所有未分组的行仍需各自存在":
		"Optional OR group name. One hit inside a group satisfies that group; every ungrouped row still has to exist on its own.",
	"勾选后隐藏匹配项的父目录（dir:）。对随机父目录场景必须勾选":
		"Hide the parent directory of the match instead of the entry itself (dir:). Required for random parent directories.",
	"/system/app/example 或 /dev/???/marker":
		"/system/app/example or /dev/???/marker",
	"OR 组名（可选）": "OR group name (optional)",
	"隐藏父目录（dir:）": "Hide the parent directory (dir:)",
	"删除路径 {0}": "Delete path {0}",
	"（空）": "(empty)",

	// Mask tab.
	"英文界面": "English interface",
	"状态总览": "Status overview",
	"路径配置说明": "Path configuration help",
	"添加": "Add",
	"自动识别 Scene debugfs": "Auto-detect Scene debugfs",
	"路径": "Path",
	"父级": "Parent",
	"作用范围": "Scope",
	"从 ls 列表中抹掉": "Remove from ls output",
	"在父目录的 <code>ls</code> 结果里抹掉这一行（hook <code>getdents64</code>），让上级目录看起来更\"干净\"。<strong>不影响</strong>父目录本身是否存在，也跟下方路径行里的「父级」是两件事。":
		"Drop this row from the parent directory's <code>ls</code> output (hooks <code>getdents64</code>) so the parent looks cleaner. It does <strong>not</strong> affect whether the parent directory exists, and it is a different thing from the Parent toggle in the path rows below.",
	"syscall 兜底": "syscall fallback",
	"用 kretprobe 拦下 stat / access / readlink / openat 等 7 个 arm64 syscall 入口，绕开 ThinLTO 内联导致的 hook 漏触发。默认勾上 6 个，唯独不挂 <code>faccessat</code>（实测 Holmes \"Abnormal Environment 04\" 通过 <code>access(F_OK)</code> 时序识别这一个 syscall 的 trampoline 开销）。":
		"Hook 7 arm64 syscall entries (stat / access / readlink / openat and friends) with kretprobes, so ThinLTO inlining cannot hide the calls. Six of them are on by default; <code>faccessat</code> is the only one left unhooked, because on a real device Holmes \"Abnormal Environment 04\" trips on the trampoline cost of that single syscall through <code>access(F_OK)</code> timing.",
	"选择具体 syscall（高级）": "Pick individual syscalls (advanced)",
	"取消勾选某项即不挂对应的 kretprobe。<strong>不推荐勾选 <code>faccessat</code></strong>：会触发 Holmes 04，且大多数应用的 <code>access(path)</code> 在 flag=0 时走的是 <code>faccessat2</code>，<code>faccessat</code> 主要被 timing 探测器使用。":
		"Unchecking an entry leaves its kretprobe unhooked. <strong>Leave <code>faccessat</code> unchecked</strong>: it trips Holmes 04, and most apps' <code>access(path)</code> with flag=0 goes through <code>faccessat2</code> anyway, so <code>faccessat</code> is mostly used by timing detectors.",
	"不推荐": "not recommended",
	"access(path), F_OK 时序探测面": "access(path), F_OK timing surface",
	"open() 主路径": "open() main path",
	"open() 新接口": "open() new interface",
	"系统应用": "System apps",
	"加载": "Load",
	"搜索包名": "Search package name",
	"直接填写 UID": "Enter UIDs directly",
	"每行一个 UID": "One UID per line",
	"白名单系统 UID 放行": "Always allow system UIDs",
	"仅 allow 模式生效。勾选表示这些系统/调试 UID 不被隐藏；取消勾选后它们也会按白名单规则被屏蔽。":
		"Only applies in allowlist mode. Checked means these system / debug UIDs are never hidden; unchecked applies the allowlist rule to them as well.",
	"root / su / 文件管理器 helper": "root / su / file manager helper",
	"开机等待秒数": "Boot wait time",
	"路径出现 + 包名解析的总等待秒数": "Total wait for paths + package resolution",
	"默认 60 秒。开机时 service.sh 会用这一段时间等待隐藏路径出现，并在 deny / allow 模式下等待包名解析为 UID。两个阶段共用同一段预算，到期就跳过加载。包名解析慢的设备可以调大。":
		"60 seconds by default. At boot service.sh spends this budget waiting for hidden paths to appear, and in deny / allow mode for package names to resolve into UIDs. Both stages share the budget; once it runs out the load is skipped. Raise it on devices where package resolution is slow.",

	// Status line, toasts and per-scope copy (rendered from JS).
	"正在处理，请稍等": "Still working, one moment",
	"正在读取配置...": "Reading configuration...",
	"正在刷新...": "Refreshing...",
	"正在保存...": "Saving...",
	"正在热重载...": "Reloading...",
	"正在暂停隐藏...": "Pausing hiding...",
	"正在生成诊断...": "Running diagnostics...",
	"正在校验配置...": "Validating configuration...",
	"正在加载应用...": "Loading apps...",
	"正在加载历史诊断...": "Loading diagnostic history...",
	"正在刷新日志...": "Refreshing logs...",
	"正在恢复默认配置...": "Restoring defaults...",
	"正在应用写入伪装策略...": "Applying the write policy...",
	"模块已加载": "Module loaded",
	"模块未加载": "Module not loaded",
	"应用白名单": "App allowlist",
	"应用黑名单": "App denylist",
	"应用列表": "App list",
	"白名单模式：默认隐藏所有应用，勾选的应用不会被隐藏。":
		"Allowlist mode: everything is hidden by default; checked apps are exempt.",
	"黑名单模式：勾选的应用会看不到隐藏路径。":
		"Denylist mode: checked apps cannot see the hidden paths.",
	"全局模式：所有应用都会看不到隐藏路径，应用列表不会参与判断。":
		"Global mode: every app loses sight of the hidden paths; the app list is not consulted.",

	// Auto-detected Scene debugfs status (rendered from JS).
	"已保存，热重载或重启后开始自动识别":
		"Saved. Auto-detection starts after a hot reload or reboot.",
	"已关闭，热重载或重启后移除已识别路径":
		"Disabled. Detected paths are dropped after a hot reload or reboot.",
	"已识别：{path}": "Detected: {path}",
	"已识别 {count} 个 /dev debugfs 挂载点": "Detected {count} /dev debugfs mount points",
	"未安装 Scene，已跳过自动识别": "Scene is not installed, auto-detection skipped",
	"前台扫描未找到，后台监视 Scene 挂载":
		"Not found by the foreground scan; watching for Scene mounts in the background",
	"已发现晚启动挂载点，正在受控热重载…":
		"Late mount point found, reloading under control…",
	"已发现挂载点，自动热重载正在重试": "Mount point found, retrying the automatic reload",
	"已发现挂载点，但自动热重载失败": "Mount point found, but the automatic reload failed",
	"后台监视超时，可在 Scene 启动后手动热重载":
		"Background watch timed out; hot reload manually once Scene starts",
	"正在等待 Scene debugfs 挂载点…": "Waiting for the Scene debugfs mount point…",
	"自动识别失败，请查看诊断日志": "Auto-detection failed, check the diagnostic log",
	"本次未识别到挂载点，其他隐藏路径不受影响":
		"No mount point detected this time; other hidden paths are unaffected",
	"热重载或重启时自动识别": "Detected automatically on hot reload or reboot",

	// Bridge / boot failures (the WebUI still renders when these fire).
	"KernelSU WebUI API 不可用": "The KernelSU WebUI API is not available",
	"命令失败：{errno}": "Command failed: {errno}",
	"读取失败": "Failed to read the configuration",

	// Error traps (they can fire before EN_TEXT exists, so t() stays safe
	// and falls back to the Chinese source in that window).
	"未知错误": "unknown error",
	"脚本错误：{0} {1}": "Script error: {0} {1}",
	"Promise 错误：{0}": "Promise error: {0}",

	// Health list (Diagnostics tab).
	"旧 nohello 模块仍在运行": "The legacy nohello module is still running",
	"卸载旧模块并重启后再安装 PathMask。":
		"Uninstall the old module, reboot, then install PathMask.",
	"查看脚本日志和内核日志，重点找 ko 缺失、KMI 不匹配、UID 为空或目标路径不存在。":
		"Check the script log and the kernel log for a missing .ko, a KMI mismatch, an empty UID list, or target paths that do not exist.",
	"pathmask.ko 不存在": "pathmask.ko is missing",
	"{0} 缺失，重新安装模块包。": "{0} is missing; reinstall the module package.",
	"模块文件存在": "Module file present",
	"procguard.ko 缺失": "procguard.ko is missing",
	"procguard.conf 为启用但模块包里没有 procguard.ko，隔离防护不可用。":
		"procguard.conf enables it, but the module package has no procguard.ko, so the isolated-process guard is unavailable.",
	"隔离防护生效中": "Isolated-process guard active",
	"procguard 已加载，已拦截 {0} 次 readproc 查询。":
		"procguard is loaded and has blocked {0} readproc lookups.",
	"隔离防护已启用但未加载": "Isolated-process guard enabled but not loaded",
	"在「防护」页重新切换一次开关，或点「保存并热重载」。":
		"Toggle it once on the Guard tab, or press Save & reload.",
	"隔离防护已停用": "Isolated-process guard disabled",
	"隔离进程仍可遍历 /proc；需要时到「防护」页启用。":
		"Isolated processes can still walk /proc; enable it on the Guard tab when you need it.",
	"{0}为空": "{0} is empty",
	"{0} 模式下没有包名或 UID，service.sh 会跳过加载。":
		"No package names or UIDs in {0} mode, so service.sh skips the load.",
	"，系统 UID {0} 个": ", {0} system UIDs",
	"{0}模式有目标": "{0} mode has targets",
	"包名 {0} 个，直接 UID {1} 个{2}。": "{0} package names, {1} direct UIDs{2}.",
	"隐藏路径为空": "No hidden paths",
	"至少保留一个存在的路径，否则模块不会加载。":
		"Keep at least one path that exists, otherwise the module will not load.",
	"仅依赖 Scene 自动识别": "Relies on Scene auto-detection only",
	"如果等待时间内没有识别到 /dev debugfs，模块将跳过加载。":
		"If no /dev debugfs mount shows up within the wait budget, the module skips the load.",
	"隐藏路径配置有效": "Hidden path configuration is valid",
	"{0} 条路径（当前模式下被自身隐藏，跳过 stat 探测）。":
		"{0} paths (hidden from the current mode itself, so the stat probe is skipped).",
	"内核已解析 {0}/{1} 条路径（当前模式下 stat 会被自身拦截，故跳过用户态探测）。":
		"The kernel resolved {0}/{1} paths (stat is intercepted by the module in the current mode, so the userspace probe is skipped).",
	"内核未解析到任何路径": "The kernel resolved no paths at all",
	"配置了 {0} 条路径但内核加载时全部跳过；可能配置变更后未重启或热重载。":
		"{0} paths are configured but every one was skipped at load time; the configuration may have changed without a reboot or hot reload.",
	"部分路径未解析": "Some paths were not resolved",
	"内核仅解析了 {0}/{1} 条路径，剩余的在加载时不存在被跳过；查看 dmesg 找具体哪一条。":
		"The kernel resolved only {0}/{1} paths; the rest did not exist at load time and were skipped. Check dmesg to see which one.",
	"有路径当前不存在": "Some paths do not exist right now",
	"不存在的路径会在内核加载时被跳过。":
		"Paths that do not exist are skipped when the kernel loads the module.",
	"{0} 条路径。": "{0} paths.",
	"Scene 自动识别配置尚未应用": "The Scene auto-detection setting is not applied yet",
	"点击“保存并热重载”或重启后生效。": "Press Save & reload or reboot to apply it.",
	"Scene debugfs 已自动识别": "Scene debugfs was detected automatically",
	"运行时路径已加入内核目标。": "The runtime path was added to the kernel targets.",
	"设备未安装 Scene": "Scene is not installed on this device",
	"已跳过自动识别，不等待，也不会匹配其他工具创建的 /dev debugfs。":
		"Auto-detection is skipped: nothing is waited for, and /dev debugfs mounts created by other tools are not matched.",
	"正在后台等待 Scene 挂载": "Waiting for a Scene mount in the background",
	"其他有效路径已立即加载；后台发现 Scene debugfs 后会执行一次受控热重载。":
		"Other valid paths loaded immediately; once Scene debugfs appears, one controlled hot reload runs.",
	"已发现晚启动的 Scene debugfs": "A late-starting Scene debugfs was found",
	"正在尝试将动态路径补充进内核目标。": "Adding the dynamic path to the kernel targets.",
	"Scene 自动补充热重载失败": "The Scene auto-append hot reload failed",
	"挂载点已经识别，但未确认进入内核目标；请手动点击“保存并热重载”。":
		"The mount point was detected but is not confirmed in the kernel targets; press Save & reload manually.",
	"Scene 后台启动监视超时": "The background watch for Scene timed out",
	"Scene 启动后可手动点击“保存并热重载”。": "Start Scene, then press Save & reload manually.",
	"本次未识别到 Scene debugfs": "No Scene debugfs was detected this time",
	"其他有效隐藏路径仍会正常加载；可在 Scene 运行后再次热重载。":
		"Other valid hidden paths still load normally; hot reload again once Scene is running.",
	"Scene debugfs 自动识别失败": "Scene debugfs auto-detection failed",
	"无法读取 mountinfo 或 stat SELinux 上下文，查看脚本日志。":
		"Could not read mountinfo or stat the SELinux context; check the script log.",
	"连续加载失败保护已触发": "The repeated-failure skip guard tripped",
	"保存并热重载会重置保护并重新尝试加载。":
		"Save & reload resets the guard and retries the load.",
	"最近发生过加载失败": "A load failure happened recently",
	"配置错误": "Configuration error",
	"配置警告": "Configuration warning",
	"配置校验": "Configuration check",
	"模块被禁用": "Module disabled",
	"删除 disable 文件或在 KernelSU 管理器中启用模块。":
		"Delete the disable file or enable the module in KernelSU Manager.",
	"发现旧配置目录": "Legacy configuration directory found",
	"{0} 存在，PathMask 会尝试迁移但不会自动删除。":
		"{0} exists; PathMask tries to migrate it but never deletes it automatically.",

	// Relative timestamps and taint decoding used by the report.
	"0 (干净)": "0 (clean)",
	"{0} (未识别)": "{0} (unrecognised)",
	"{0} 秒前": "{0}s ago",
	"{0} 分钟前": "{0} min ago",
	"{0} 小时前": "{0}h ago",
	"{0} 天前": "{0}d ago",

	// Diagnostic fact gathering.
	"权限被拒（SELinux / capabilities / dmesg_restrict）":
		"Permission denied (SELinux / capabilities / dmesg_restrict)",
	"dmesg_restrict=1（系统锁定，root WebUI shell 也无权读，部分 OnePlus / OEM ROM 默认如此）":
		"dmesg_restrict=1 (locked down: even a root WebUI shell cannot read it; the default on some OnePlus / OEM ROMs)",
	"dmesg 命令失败（{0}）": "dmesg command failed ({0})",
	"dmesg 无 pathmask 相关行": "no pathmask lines in dmesg",

	// Verdict (Diagnostics tab).
	"模块在跑，但 conf 已被修改且未热重载（{0}）":
		"Module is running, but the conf changed without a hot reload ({0})",
	"sysfs 显示的运行参数和 *.conf 不一致；说明你改完 conf 没点「保存并热重载」也没重启。":
		"The running sysfs parameters do not match *.conf: the conf was edited without Save & reload and without a reboot.",
	"用「保存并热重载」让新配置生效，或者重启。":
		"Press Save & reload to apply the new configuration, or reboot.",
	"模块在跑，但只解析到 {0}/{1} 条目标路径":
		"Module is running, but only {0}/{1} target paths resolved",
	"剩余路径在加载时不存在，被内核 skip 了。":
		"The remaining paths did not exist at load time and were skipped by the kernel.",
	"看「dmesg pathmask 相关」段里 'not found (err=...)' 行确认是哪一条。":
		"Look for the 'not found (err=...)' lines in the dmesg section to see which one.",
	"如果是带 ??? 的 glob 行匹配不到，是预期的（路径未生成）；如果是字面路径，多半拼错了或路径被系统改过。":
		"A ??? glob that matches nothing is expected (the path was not created yet); a literal path is most likely misspelled or was changed by the system.",
	"{0}/{1} 个{2}包名当前无法解析为 UID":
		"{0}/{1} {2} package names cannot be resolved to a UID right now",
	"未解析：{0}": "Unresolved: {0}",
	"包名拼错、应用未安装、或者它是隔离进程（隔离 UID 在 90000-98999 / 99000-99999 范围，PM 查不到）。":
		"The name may be misspelled, the app may not be installed, or it may be an isolated process (isolated UIDs live in 90000-98999 / 99000-99999, which PM cannot resolve).",
	"对照「应用{0}」面板里实际显示的包名；如果是隔离进程，手填直接 UID。":
		"Compare against the names actually shown on the App {0} panel; for an isolated process, type the UID directly.",
	"修好 conf 后点「保存并热重载」让新的 UID 解析生效。":
		"Fix the conf, then press Save & reload so the new UID resolution takes effect.",
	"hook 已挂上但从未被任何进程触发":
		"Hooks are installed but no process has ever triggered them",
	"已经过去 {0}，dmesg 里没有任何 'hook fired (first time)' 行。":
		"{0} have passed and dmesg still has no 'hook fired (first time)' line.",
	"说明黑名单里的 UID 实际上从未访问过目标路径，或者它们用了 PathMask 还没覆盖的 syscall。":
		"That means the denylisted UIDs never touched a target path, or they reached it through a syscall PathMask does not cover yet.",
	"如果你期望某个应用被拦截：在 logcat -s pathmask 里搜 hook fired，或者让应用重新启动后重测。":
		"If you expected an app to be intercepted: search for hook fired in logcat -s pathmask, or restart the app and retest.",
	"PathMask 正在运行（已实战触发：{0}）":
		"PathMask is running (already triggered in the wild: {0})",
	"PathMask 正在运行": "PathMask is running",
	"如果实际表现仍异常（被检测到、目标可见），用「校验配置」检查是否所有目标都被解析。":
		"If behaviour still looks wrong (detection hits, visible targets), use Configuration check to confirm every target resolved.",
	"模块被 KSU 禁用": "Module disabled by KernelSU",
	"在 KernelSU 管理器中启用 PathMask，或删除 {0}/disable / remove。":
		"Enable PathMask in KernelSU Manager, or delete {0}/disable / remove.",
	"启用后重启或点「保存并热重载」。": "After enabling, reboot or press Save & reload.",
	"模块文件 pathmask.ko 缺失": "The module file pathmask.ko is missing",
	"重新刷入对应 KMI 的 ksu zip。": "Flash the ksu zip that matches this KMI again.",
	"确认 {0} 在重启后存在。": "Confirm that {0} exists after a reboot.",
	"连续 {0} 次 insmod 失败，已自动跳过加载":
		"{0} insmod failures in a row, so the load was skipped automatically",
	"失败原因：{0}": "Failure reason: {0}",
	"修复底层原因（看下方建议）后再重试。":
		"Fix the underlying cause (see the suggestions below) and retry.",
	"在「快速操作」点「校验配置」找具体原因；修好后用「保存并热重载」即可重置失败保护。":
		"Use Configuration check under Quick actions to find the cause; once fixed, Save & reload resets the failure guard.",
	"最近发生过 {0}/3 次 insmod 失败": "{0}/3 recent insmod failures",
	"下次开机会再试一次；继续失败将触发跳过保护。":
		"The next boot tries once more; further failures trip the skip guard.",
	"如果反复失败，多半是 KMI / OEM 内核 CRC 不兼容（看「内核环境」段）。":
		"Repeated failures usually mean a KMI / OEM kernel CRC mismatch (see the Kernel environment section).",
	"service.sh 等待目标路径超时": "service.sh timed out waiting for target paths",
	"开机时 wait_seconds 内目标路径仍不可见，所以 service.sh 主动跳过加载（这是预期行为，不算 bug）。":
		"The target paths never became visible within wait_seconds at boot, so service.sh skipped the load on purpose (expected behaviour, not a bug).",
	"重启一次通常能恢复（系统第一次冷启动挂载较慢）。":
		"One reboot usually clears it (mounts are slow on the first cold boot).",
	"如果反复出现，把 {0}/wait_seconds.conf 调到 90 或 120 秒。":
		"If it keeps happening, raise {0}/wait_seconds.conf to 90 or 120 seconds.",
	"allow 白名单没有解析到任何 UID": "The allowlist resolved no UIDs at all",
	"deny 模式下没有解析到任何 UID": "No UIDs resolved in denylist mode",
	"allow 模式至少需要一个能解析到 UID 的白名单应用。":
		"Allowlist mode needs at least one allowlisted app that resolves to a UID.",
	"deny 模式至少需要一个能解析到 UID 的应用。":
		"Denylist mode needs at least one app that resolves to a UID.",
	"在「应用{0}」里勾选应用，或在「直接 UID」里手填，然后保存并重启。":
		"Tick apps on the App {0} panel or type UIDs directly, then save and reboot.",
	"目标路径列表为空": "The target path list is empty",
	"在「隐藏路径」里至少添加一条路径，否则模块没东西可隐藏，service.sh 会跳过加载。":
		"Add at least one path under Hidden paths; otherwise there is nothing to hide and service.sh skips the load.",
	"失败保护跳过加载": "The failure guard skipped the load",
	"清掉失败计数（点「保存并热重载」会自动清）后再试。":
		"Clear the failure counter (Save & reload does it automatically) and retry.",
	"旧 nohello 模块仍在内核里": "The legacy nohello module is still in the kernel",
	"卸载旧的 nohello 模块再装 PathMask，或者直接在 KernelSU 管理器里把 nohello 禁用并重启。":
		"Uninstall the old nohello module before installing PathMask, or disable nohello in KernelSU Manager and reboot.",
	"service.sh 报告 {0}": "service.sh reports {0}",
	"详情：{0}": "Details: {0}",
	"重点看下方「dmesg pathmask 相关」段，最常见是 KMI / CRC 不匹配。":
		"Look at the dmesg section below; the usual cause is a KMI / CRC mismatch.",
	"service.sh 觉得加载成功，但 /proc/modules 里没有 pathmask":
		"service.sh believes the load succeeded, but /proc/modules has no pathmask",
	"模块加载后又被卸载了，或者 insmod 返回 0 但内核拒绝了模块。":
		"The module was unloaded again, or insmod returned 0 while the kernel rejected it.",
	"重启一次再生成诊断；仍然这样的话看「dmesg pathmask 相关」段（如果可读）。":
		"Reboot and run diagnostics again; if it persists, read the dmesg section below (when readable).",
	"service.sh 仍在 {0} 阶段": "service.sh is still in the {0} stage",
	"等几秒后再生成诊断，让开机脚本走完。":
		"Wait a few seconds and run diagnostics again so the boot script can finish.",
	"用户从 WebUI 暂停了隐藏": "Hiding was paused from the WebUI",
	"点「保存并热重载」恢复。": "Press Save & reload to resume.",
	"service.sh 似乎从未被调度执行": "service.sh never seems to have run",
	"没有 /data/adb/pathmask/boot_state 说明开机脚本根本没跑过。":
		"There is no /data/adb/pathmask/boot_state, so the boot script never ran.",
	"先重启一次（这一类问题在 OnePlus / OxygenOS 上首次安装后很常见，重启后正常）。":
		"Reboot once first (common on OnePlus / OxygenOS right after the first install; it settles after a reboot).",
	"重启后还是这样，确认 KSU 管理器里 PathMask 是「已启用」状态。":
		"If it persists after a reboot, make sure PathMask is Enabled in KernelSU Manager.",
	"模块未加载，原因不在已知列表里":
		"The module is not loaded and the cause is not in the known list",
	"先重启一次（很多偶发问题靠重启就能解决）。":
		"Reboot once first (that clears most one-off failures).",
	"还有问题的话，从 root shell 跑：`insmod /data/adb/modules/pathmask/pathmask.ko ; echo exit=$?` 看完整错误，然后把这份诊断 + 这条命令的输出发给开发者。":
		"If it still fails, run this from a root shell: `insmod /data/adb/modules/pathmask/pathmask.ko ; echo exit=$?` and send the developer this report plus that output.",

	// Key facts block.
	"模块加载状态": "Module state",
	"未在 /proc/modules": "not in /proc/modules",
	"模块文件": "Module file",
	"{0} 缺失": "{0} is missing",
	"{0} 字节, sha1={1}": "{0} bytes, sha1={1}",
	"KSU 启用": "Enabled in KSU",
	"模块被禁用（disable / remove flag）": "Module disabled (disable / remove flag)",
	"未被禁用": "not disabled",
	"开机阶段": "Boot stage",
	"boot_state 不存在（service.sh 未执行）": "boot_state missing (service.sh did not run)",
	"失败计数": "Failure count",
	"（含 {0} 条运行时自动识别路径）": " (including {0} runtime auto-detected paths)",
	"（部分路径加载时不存在被 skip）": " (some paths did not exist at load time and were skipped)",
	"路径解析": "Path resolution",
	"内核解析 {0} / 配置 {1}{2}": "kernel {0} / configured {1}{2}",
	"写入伪装策略": "Write policy",
	"（配置为 {0}，未热重载）": " (configured as {0}, not hot reloaded)",
	"hook 命中": "Hook hits",
	"已实战触发：{0}": "Triggered in the wild: {0}",
	"挂载 {0} 个，但 dmesg 中尚未见任何 'fired (first time)' 行（开机不久或作用 UID 未访问目标）":
		"{0} hooked, but dmesg has no 'fired (first time)' line yet (early after boot, or the target UIDs have not touched a target)",
	"主动跳过的 hook": "Deliberately unhooked",
	"conf 已修改但内核仍在用旧值（点「保存并热重载」）":
		"conf changed but the kernel still runs the old values (press Save & reload)",
	"{0}/{1} 个包名全部解析成功": "all {0}/{1} package names resolved",
	"{0}/{1} 个包名解析成功，{2} 个失败": "{0}/{1} package names resolved, {2} failed",
	"包名→UID 解析": "Package name to UID",
	"  …+{0} 个未列出": "  …+{0} more not listed",
	"sysfs 孤立 UID": "Orphan UIDs in sysfs",
	"{0}（来源不明，多半是删过包名但没热重载）":
		"{0} (origin unknown; probably package names were removed without a hot reload)",
	"无": "none",
	" … (共 {0} 个)": " … ({0} total)",
	"其他 LKM": "Other LKMs",
	"{0}（说明本机能加载 LKM）": "{0} (so this device can load LKMs)",

	// dmesg / kernel environment / procguard sections of the report.
	"(dmesg 中没有 pathmask 相关行)": "(no pathmask lines in dmesg)",
	"--- raw dmesg pathmask 相关 ---": "--- raw dmesg pathmask lines ---",
	"(空)": "(empty)",
	"内核版本": "Kernel version",
	"(读不到 uname -r)": "(uname -r unavailable)",
	"内核 KMI": "Kernel KMI",
	"{0}（请确认安装的 zip 也是这个 KMI）":
		"{0} (make sure the installed zip matches this KMI)",
	"{0}（{1}）— OEM 改过 GKI；dmesg 可见 CRC / unknown symbol 错误，多半就是这里不兼容。换 SukiSU / KernelPatch 或自编内核试试":
		"{0} ({1}) — the OEM changed the GKI; CRC / unknown symbol errors in dmesg usually come from here. Try SukiSU / KernelPatch or a self-built kernel",
	"{0}（{1}）— OEM 改过 GKI，CRC 理论上可能不兼容，但当前模块跑得正常":
		"{0} ({1}) — the OEM changed the GKI, so a CRC mismatch is theoretically possible, but the module runs fine right now",
	"OEM 后缀": "OEM suffix",
	"{0}（如果 insmod 报 invalid module format，多半是 page size 不一致）":
		"{0} (if insmod reports invalid module format, the page size probably differs)",
	"内核污染位": "Kernel taint",
	"dmesg 权限": "dmesg access",
	"可读": "readable",
	"内核拒绝信号": "Kernel rejection signals",
	"dmesg 含 {0} 行 CRC / unknown symbol / invalid module 错误，看下方 dmesg 段获取具体行":
		"dmesg has {0} lines of CRC / unknown symbol / invalid module errors; see the dmesg section below for the exact lines",
	"已加载: {0}": "Loaded: {0}",
	"存在": "present",
	"缺失": "missing",
	"1（启用）": "1 (enabled)",
	"0（停用）": "0 (disabled)",
	"是": "yes",
	"否": "no",

	// Report skeleton.
	"PathMask 诊断报告\n（点「生成诊断」后这里会出现可复制报告）":
		"PathMask diagnostic report\n(press Run diagnostics to fill this with a copyable report)",
	"PathMask 诊断报告": "PathMask diagnostic report",
	"生成时间: {0}": "Generated: {0}",
	"模块版本: {0}": "Module version: {0}",
	"=== 结论 ===": "=== Verdict ===",
	"建议：": "Suggestions:",
	"=== 关键事实 ===": "=== Key facts ===",
	"=== 内核环境 ===": "=== Kernel environment ===",
	"=== 配置文件 ===": "=== Configuration files ===",
	"(未采集)": "(not collected)",
	"=== procguard（隔离防护） ===": "=== procguard (isolated-process guard) ===",
	"=== 脚本日志 logcat ===": "=== Script log (logcat) ===",
	"(无 pathmask 相关 logcat{0})": "(no pathmask logcat lines{0})",
	"=== dmesg pathmask 相关 ===": "=== dmesg pathmask lines ===",
	"(dmesg 不可读：{0})": "(dmesg unreadable: {0})",
	"=== 原始数据 ===": "=== Raw data ===",
	"--- 模块状态 ---": "--- Module state ---",

	// Copy toasts, app loading, procguard panel and boot state.
	"没有可复制内容": "Nothing to copy",
	"已复制": "Copied",
	"复制失败，请长按文本框手动复制":
		"Copy failed; long-press the text box to copy it manually",
	"已加载 {0} 个应用": "Loaded {0} apps",
	"当前模块包未包含 procguard.ko，防护不可用":
		"This module package does not include procguard.ko, so the guard is unavailable",
	"procguard 已加载：已拦截 {0} 次隔离进程对 gid {1} 的查询（missed={2}）":
		"procguard loaded: blocked {0} isolated-process lookups for gid {1} (missed={2})",
	"已启用但尚未加载：重新切换一次开关或热重载后生效":
		"Enabled but not loaded yet: toggle the switch again or hot reload",
	"已停用：隔离进程仍可遍历 /proc": "Disabled: isolated processes can still walk /proc",
	"隔离防护已启用": "Isolated-process guard enabled",
	"自动诊断中（Scene 后台监视完成）...": "Running diagnostics (Scene background watch finished)...",
	"自动诊断中（开机完成）...": "Running diagnostics (boot finished)...",
	"自动诊断中...": "Running diagnostics...",
	"自动诊断中（页面加载）...": "Running diagnostics (page load)...",
	"开机服务正在准备": "The boot service is starting",
	"service.sh 已开始执行，正在加载配置。":
		"service.sh has started and is loading the configuration.",
	"正在等待隐藏路径出现": "Waiting for hidden paths to appear",
	"还需等待最多 {0} 秒，超时仍不存在的路径会被跳过。{1}":
		"Up to {0}s left; paths that still do not exist are skipped when it expires.{1}",
	"等待已超时，模块可能已跳过加载。{0}":
		"The wait timed out; the module may have skipped the load.{0}",
	"正在等待包名解析为 UID": "Waiting for package names to resolve to UIDs",
	"还需等待最多 {0} 秒，超时未解析到 UID 会跳过加载。{1}":
		"Up to {0}s left; unresolvable UIDs are skipped when it expires.{1}",
	"上次开机时模块已存在": "The module was already loaded at the last boot",
	"service.sh 检测到 pathmask 已被加载，跳过 insmod。":
		"service.sh found pathmask already loaded and skipped insmod.",
	"所有隐藏路径在等待结束时仍不存在":
		"No hidden path existed when the wait ended",
	"service.sh 跳过加载。可调大等待秒数或检查路径是否拼写正确。{0}":
		"service.sh skipped the load. Raise the wait, or check the paths for typos.{0}",
	"allow 白名单未解析到任何 UID": "The allowlist resolved no UIDs",
	"deny 模式下未解析到任何 UID": "No UIDs resolved in denylist mode",
	"service.sh 跳过加载。检查包名是否拼写正确，或填写直接 UID。{0}":
		"service.sh skipped the load. Check the package names for typos, or enter UIDs directly.{0}",
	"隐藏路径配置为空": "The hidden path list is empty",
	"service.sh 立即退出。{0}": "service.sh exits immediately.{0}",
	"连续加载失败保护跳过加载": "The repeated-failure guard skipped the load",
	"保存并热重载会重置保护并重试。{0}":
		"Save & reload resets the guard and retries.{0}",
	"旧 nohello 模块占据内核": "The legacy nohello module occupies the kernel",
	"卸载旧模块后重启即可加载 PathMask。{0}":
		"Uninstall the old module and reboot to load PathMask.{0}",
	"pathmask.ko 文件丢失": "The file pathmask.ko is gone",
	"重新安装模块包。{0}": "Reinstall the module package.{0}",
	"insmod 失败": "insmod failed",
	"查看内核日志找 vermagic / unknown symbol / module_layout 等原因。{0}":
		"Check the kernel log for vermagic / unknown symbol / module_layout and similar.{0}",
	"WebUI 已暂停隐藏": "Hiding is paused from the WebUI",
	"热重载或重启后会恢复加载。": "A hot reload or reboot resumes loading.",

	// Configuration validation.
	"隐藏路径为空。": "The hidden path list is empty.",
	"隐藏路径必须是绝对路径：{0}": "A hidden path must be absolute: {0}",
	"隐藏路径不能包含英文逗号：{0}":
		"A hidden path cannot contain an ASCII comma: {0}",
	"组名不能包含冒号或空白：{0}":
		"A group name cannot contain a colon or whitespace: {0}",
	"重复路径会被重复传入内核：{0}":
		"A duplicate path is passed to the kernel twice: {0}",
	"UID 只能填写数字：{0}": "A UID must be a number: {0}",
	"等待秒数为空，将使用默认值 {0}。": "The wait is empty; the default of {0} is used.",
	"等待秒数只能填写正整数：{0}": "The wait must be a positive integer: {0}",
	"等待秒数必须大于 0。": "The wait must be greater than 0.",
	"等待秒数较大（{0}s），开机加载会变慢。":
		"The wait is long ({0}s); boot loading will be slower.",
	"{0}模式下至少需要选择一个包名、填写一个 UID，或勾选系统 UID 放行。":
		"{0} mode needs at least one package name, one UID, or a system UID exemption.",
	"模块文件不存在：{0}": "The module file does not exist: {0}",
	"内核仅解析了 {0}/{1} 条路径（当前模式下 stat 会被自身拦截，跳过用户态校验）。":
		"The kernel resolved only {0}/{1} paths (stat is intercepted by the module in the current mode, so the userspace check is skipped).",
	"当前所有隐藏路径都不存在，service.sh 会等待后跳过加载。":
		"None of the hidden paths exist right now; service.sh waits and then skips the load.",
	"{0} 条隐藏路径当前不存在，内核加载时会跳过这些路径。":
		"{0} hidden paths do not exist right now and will be skipped when the kernel loads the module.",
	"当前选择的包名可能都无法解析 UID，开机服务可能会跳过加载。":
		"None of the selected package names may resolve to a UID; the boot service may skip the load.",
	"{0} 个包名当前未在 packages.list 中找到。":
		"{0} package names are not in packages.list right now.",
	"配置校验通过。": "Configuration check passed.",
	"配置校验未通过": "Configuration check failed",
	"配置有 {0} 个错误": "{0} configuration errors",
	"配置校验有警告": "Configuration check has warnings",
	"配置校验通过": "Configuration check passed",
	"校验完成：{0} 个警告": "Check finished: {0} warnings",

	// Save / reload / pause flows.
	"已保存，重启后生效": "Saved; takes effect after a reboot",
	"恢复默认配置会覆盖所有 *.conf（清空白名单包名和直接 UID），并丢弃页面上未保存的修改。确定继续？":
		"Restoring defaults overwrites every *.conf (clearing the allow-list packages and the direct UIDs) and discards any edits on this page that were never saved. Continue?",
	"已取消，配置未改动": "Cancelled; the configuration is unchanged",
	"跟随原厂": "OEM default",
	"伪装不存在": "Pretend it does not exist",
	"旧版行为": "Legacy behaviour",
	"写入伪装已切换为「{0}」": "Write policy switched to {0}",
	"热重载完成；未安装 Scene，已跳过自动识别":
		"Hot reload done; Scene is not installed, so auto-detection was skipped",
	"热重载完成，后台继续等待 Scene 启动":
		"Hot reload done; still watching for Scene in the background",
	"热重载完成，但当前未识别到 Scene debugfs":
		"Hot reload done, but no Scene debugfs was detected",
	"热重载完成": "Hot reload done",
	"隐藏已暂停，热重载可恢复": "Hiding paused; a hot reload resumes it",
	"隐藏已暂停": "Hiding paused",
	"已恢复默认配置，重启后生效": "Defaults restored; takes effect after a reboot",
	"logcat 不可读（{0}）": "logcat unreadable ({0})",
	"诊断已生成": "Diagnostics generated",
	"诊断报告已生成": "Diagnostic report generated",
	"（暂无历史诊断。每次点「生成诊断」会自动保存一份。）":
		"(No history yet. Every Run diagnostics saves one snapshot.)",
	"正在启用隔离防护...": "Enabling the isolated-process guard...",
	"正在停用隔离防护...": "Disabling the isolated-process guard...",
	"保存并热重载或重启后生效": "Takes effect after Save & reload or a reboot",

	// Inline fallbacks that live inside larger templates.
	"很久": "a long while",
	"查看内核日志。": "check the kernel log.",
	"(未解析)": "(unresolved)",
	"无 pathmask 相关 logcat": "no pathmask logcat lines",
	"{0}/3：{1}": "{0}/3: {1}",

	// Guard tab.
	"隔离防护": "Isolated-process guard",
	"启用隔离防护(procguard)": "Enable the isolated-process guard (procguard)",
	"隔离进程会从 zygote 继承 gid 3009(AID_READPROC)，可以遍历全部 <code>/proc/&lt;pid&gt;</code> 并读取任意进程的 mountinfo / cmdline / maps，借此发现 Magisk/KSU 模块挂载(LSPosed Privisolated 披露)。启用后由 procguard.ko 在内核 <code>in_group_p()</code> 处让该 gid 对隔离 UID(90000-99999)失效，<code>/proc/self</code> 不受影响。开关默认关闭，由你决定是否启用。":
		"Isolated processes inherit gid 3009 (AID_READPROC) from zygote, which lets them walk every <code>/proc/&lt;pid&gt;</code> and read any process's mountinfo / cmdline / maps, exposing Magisk/KSU module mounts (disclosed by LSPosed Privisolated). With the guard on, procguard.ko makes that gid fail for isolated UIDs (90000-99999) inside the kernel's <code>in_group_p()</code>; <code>/proc/self</code> is unaffected. The switch is off by default; enabling it is your call.",
	"正在读取状态…": "Reading status…",
	"写入行为伪装": "Write behaviour masking",
	"检测方对隐藏路径执行写操作（mkdir / Create / rename / 删除）时返回的错误码策略。切换后自动保存并热重载生效。":
		"Which errno a detection tool sees when it performs a write (mkdir / Create / rename / delete) on a hidden path. Changing it saves and hot reloads automatically.",
	"写入伪装说明": "How write masking works",
	"检测方会用写操作探测隐藏路径，并根据错误码反推路径是否存在：在 FUSE 存储上，mkdir 返回 ENOENT 恰恰是\"路径存在但被隐藏\"的特征，返回 EACCES 才与\"路径真实不存在\"一致。":
		"Detection tools probe hidden paths with write operations and infer existence from the errno: on FUSE storage an ENOENT from mkdir is precisely the signature of \"present but hidden\", while EACCES matches \"really does not exist\".",
	"<strong>跟随原厂（默认）</strong>：写操作不被拦截，由原生文件系统 / FUSE 返回原厂错误码，适合一般场景。":
		"<strong>OEM default</strong>: writes are not intercepted; the native filesystem / FUSE returns its own errno. Right for ordinary situations.",
	"<strong>伪装不存在</strong>：mkdir / Create / rename 目标返回 EACCES，删除 / rename 源返回 ENOENT，与\"路径真实不存在\"的错误码画像完全一致，阻断存在性反推。有明确对抗检测需求时选用。":
		"<strong>Pretend it does not exist</strong>: mkdir / Create / rename targets return EACCES and delete / rename sources return ENOENT, matching the errno profile of a path that truly does not exist and cutting off existence inference. Pick this when you are explicitly up against a detector.",
	"<strong>旧版行为</strong>：写操作一律返回 ENOENT，可能与原厂错误码不一致，仅为兼容旧配置保留，不建议主动选择。":
		"<strong>Legacy behaviour</strong>: every write returns ENOENT. This can disagree with the OEM errno and is kept only for old configurations; not recommended.",
	"验证方法：用检测工具对隐藏路径执行 mkdir，期望返回 EACCES 而非 ENOENT。边界：仅对作用范围内的 UID 生效；位于 App 可写目录（如 Documents）下的目标无法完全伪装。":
		"How to verify: run mkdir against a hidden path from the detector and expect EACCES rather than ENOENT. Limits: it only applies to UIDs inside the active scope, and targets inside app-writable directories (Documents, for example) cannot be fully masked.",
	"预期与排查": "What to expect and how to debug",
	"启用后，隔离进程将失去遍历 <code>/proc</code> 的能力（gid 3009 在内核层被摘除）。用 Privisolated 之类的检测 demo 验证时：":
		"With the guard on, isolated processes lose the ability to walk <code>/proc</code> (gid 3009 is dropped in the kernel). When you verify with a detector demo such as Privisolated:",
	"<strong>OK: Not found / INFO: vulnerability fixed</strong>——第一层泄漏已封堵，防护生效。":
		"<strong>OK: Not found / INFO: vulnerability fixed</strong> — the first-layer leak is closed and the guard is working.",
	"<strong>仍然 WARN，且内容是本机挂载路径</strong>——这超出了本模块的范围：说明隔离进程<em>自己的</em> mountinfo 里就能看到模块挂载（第二层问题）。procguard 只负责摘除 gid 3009，不改变挂载可见性；此时应排查其他涉及挂载的模块采用了什么挂载方式，以及 root 方案对隔离进程挂载命名空间的隐藏是否到位。":
		"<strong>Still WARN, and the content is this device's mount paths</strong> — that is outside this module's scope: it means the isolated process can see module mounts in <em>its own</em> mountinfo (a second-layer problem). procguard only removes gid 3009; it does not change mount visibility. Investigate how the other mount-related modules do their mounting, and whether your root solution hides the isolated process's mount namespace properly.",

	// Diagnostics / logs / report tabs.
	"结论": "Verdict",
	"生成诊断": "Run diagnostics",
	"快速操作": "Quick actions",
	"校验配置": "Configuration check",
	"复制诊断报告": "Copy diagnostic report",
	"历史诊断": "Diagnostic history",
	"恢复默认配置": "Restore defaults",
	"日志分页": "Log pages",
	"日志类型": "Log type",
	"刷新日志": "Refresh logs",
	"状态": "Status",
	"配置": "Config",
	"内核": "Kernel",
	"脚本": "Script",
	"上一页": "Previous",
	"下一页": "Next",
	"诊断报告": "Diagnostic report",
	"复制": "Copy",
	"点击“生成诊断”后这里会出现可复制报告":
		"Press Run diagnostics and a copyable report appears here",

	// Modals.
	"支持 PathMask": "Support PathMask",
	"关闭": "Close",
	"请确认": "Please confirm",
	"取消": "Cancel",
	"确定": "OK",
	"如果 PathMask 对你有帮助，欢迎自愿捐赠支持后续维护。":
		"If PathMask is useful to you, a voluntary donation supports its continued maintenance.",
	"微信与支付宝收款二维码": "WeChat and Alipay donation QR code",
	"请使用微信或支付宝扫码。感谢支持！":
		"Scan it with WeChat or Alipay. Thank you!",
	"每次「生成诊断」后会自动保存最近 5 份。点击下方某一份可在右侧显示内容。今天突然不工作？对比之前的快照能快速定位是哪一项变了。":
		"Every Run diagnostics keeps the last five snapshots. Click one below to show it on the right. Something stopped working today? Comparing against an earlier snapshot pinpoints what changed.",
	"选择一项查看内容": "Pick an entry to see its content",
	"复制选中": "Copy selection",
	"每行一个目标，绝对路径。匹配的文件 / 目录会从当前作用范围内的 UID 视角变为不存在。":
		"One target per line, absolute path. Matching files / directories become non-existent from the point of view of UIDs inside the active scope.",
	"开启后，仅在检测到 Scene（<code>com.omarea.vtools</code>）已安装时，才会自动查找 <code>/dev</code> 下文件系统类型为 <code>debugfs</code>、SELinux 上下文为 <code>u:object_r:debugfs:s0</code> 的随机挂载点，并作为本次运行的隐藏路径加入。未安装 Scene 时立即跳过；已有其他有效隐藏路径时，不会阻塞主模块等待 Scene，而是先加载现有目标并在后台监视，发现后受控热重载。只有完全依赖 Scene、没有其他有效目标时，才使用现有最长等待预算。识别结果不会写入下方路径列表，每次开机或热重载都会重新识别。默认关闭。":
		"When this is on, and only when Scene (<code>com.omarea.vtools</code>) is installed, the module looks for a random mount point under <code>/dev</code> whose filesystem type is <code>debugfs</code> and whose SELinux context is <code>u:object_r:debugfs:s0</code>, then adds it to this run's hidden paths. If Scene is not installed it skips immediately; if other valid hidden paths exist it does not block the main module waiting for Scene, but loads the current targets first and watches in the background, then performs a controlled hot reload once the mount appears. Only when everything depends on Scene and no other valid target exists does it spend the full wait budget. The result is never written into the path list below, and it is re-detected on every boot or hot reload. Off by default.",
	"<code>???</code> 通配符": "<code>???</code> wildcard",
	"任意一段路径名（不跨 <code>/</code>），等价于 shell <code>*</code> 但写起来不会被误读。例如 <code>/dev/???/scene_mode_category</code> 会命中 <code>/dev/asldpx_c/scene_mode_category</code>、<code>/dev/xcscvgtp/scene_mode_category</code> 等任意 8 字符随机父目录。":
		"Any single path component (never across <code>/</code>), equivalent to the shell's <code>*</code> but unambiguous to read. For example <code>/dev/???/scene_mode_category</code> matches <code>/dev/asldpx_c/scene_mode_category</code>, <code>/dev/xcscvgtp/scene_mode_category</code> and any other 8-character random parent directory.",
	"可选 OR 分组名。同名组内只要任一行命中即视为该组满足，所有未分组的行仍需各自存在。适用于「老路径 OR 新路径」这类「两套同效」的兼容配置，启动时只要任一路径出现就立即加载，没出现也不会因为等其中某一条而拖慢开机。":
		"Optional OR group name. A hit on any row inside the group satisfies the group; every ungrouped row still has to exist on its own. It is meant for \"old path OR new path\" compatibility sets: the module loads as soon as either path appears, and never slows the boot by waiting for one specific row.",
	"勾选后，命中的不是这条路径本身而是它的<strong>父目录</strong>。配合 <code>???</code> 通配能把整段随机父目录连同其所有子项一并隐藏，封死「文件存在性边信道」类检测（<code>access</code>/<code>mkdir</code>/<code>stat</code> 三连击全部返回 <code>ENOENT</code>）。":
		"When ticked, the match is not the path itself but its <strong>parent directory</strong>. Combined with <code>???</code> it hides a whole random parent directory together with all of its children, closing off file-existence side channels (the <code>access</code>/<code>mkdir</code>/<code>stat</code> triple all return <code>ENOENT</code>).",
	"语法组合": "Combining the prefixes",
	"三种前缀可叠加，固定顺序为 <code>any:&lt;组&gt;:dir:&lt;path&gt;</code>。WebUI 自动按勾选项拼装写入，手工编辑 conf 也按这个顺序。":
		"The three prefixes stack, always in the order <code>any:&lt;group&gt;:dir:&lt;path&gt;</code>. The WebUI assembles them from the checkboxes, and hand-edited conf files use the same order.",
};

/*
 * Chinese sources captured on first apply, so switching back to zh
 * restores the original markup exactly (hints contain inline <code> and
 * <strong> that must survive the round trip).
 */
const staticTextSource = new Map();
const staticHtmlSource = new Map();
const staticAttrSource = new Map();
const staticLeadSource = new Map();

let uiLang = detectUiLang();

function detectUiLang() {
	try {
		const saved = window.localStorage.getItem(UI_LANG_KEY);
		if (UI_LANGS.includes(saved)) return saved;
	} catch (error) {
		// Some WebViews run the page without persistent storage; the
		// browser language below still gives a sensible default.
	}
	const tags = navigator.languages && navigator.languages.length
		? navigator.languages
		: [navigator.language || ""];
	for (const tag of tags) {
		if (/^zh/i.test(tag)) return "zh";
		if (/^en/i.test(tag)) return "en";
	}
	return "zh";
}

function t(source, params) {
	if (source === undefined || source === null) return source;
	let text = source;
	try {
		text = uiLang === "en" ? (EN_TEXT[source] ?? source) : source;
	} catch (error) {
		// uiLang and EN_TEXT are bindings declared further down this
		// file. The window error traps at the very top call t(), and a
		// throw during top-level evaluation before those bindings are
		// initialised leaves them in the temporal dead zone -- which
		// would make the handler that exists to report the failure
		// throw itself. The untranslated source is the right fallback:
		// it is exactly what the zh build renders anyway.
	}
	if (params) {
		text = Array.isArray(params)
			? text.replace(/\{(\d+)\}/g, (match, index) => (
				params[Number(index)] !== undefined ? String(params[Number(index)]) : match
			))
			: text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
				Object.prototype.hasOwnProperty.call(params, name)
					? String(params[name])
					: match
			));
	}
	return text;
}

function applyStaticText() {
	for (const el of $$("[data-i18n]")) {
		applyCaptured(staticTextSource, el, (node) => node.textContent, (node, value) => {
			node.textContent = value;
		});
	}
	for (const el of $$("[data-i18n-html]")) {
		applyCaptured(staticHtmlSource, el, (node) => node.innerHTML, (node, value) => {
			node.innerHTML = value;
		});
	}
	for (const el of $$("[data-i18n-lead]")) {
		if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
		applyCaptured(staticLeadSource, el, (node) => node.firstChild.nodeValue, (node, value) => {
			node.firstChild.nodeValue = value;
		});
	}
	for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
		for (const el of $$(`[data-i18n-${attr}]`)) {
			let store = staticAttrSource.get(el);
			if (!store) {
				store = {};
				staticAttrSource.set(el, store);
			}
			if (!(attr in store)) store[attr] = el.getAttribute(attr) || "";
			el.setAttribute(attr, t(store[attr]));
		}
	}
	for (const el of $$(".langOption")) {
		const active = el.dataset.lang === uiLang;
		el.classList.toggle("active", active);
		el.setAttribute("aria-pressed", String(active));
	}
	document.documentElement.lang = uiLang === "en" ? "en" : "zh-CN";
}

/*
 * Remember the Chinese source once, whitespace included, and rewrite it
 * on every language change. Trimming only the lookup key is what lets a
 * hint marked with data-i18n-html keep its indentation while still
 * matching a single-line entry in EN_TEXT.
 */
function applyCaptured(store, el, read, write) {
	if (!store.has(el)) {
		const raw = read(el);
		const start = raw.length - raw.trimStart().length;
		const end = raw.trimEnd().length;
		store.set(el, {
			lead: raw.slice(0, start),
			source: raw.slice(start, end),
			tail: raw.slice(end),
		});
	}
	const record = store.get(el);
	write(el, record.lead + t(record.source) + record.tail);
}

function setUiLang(lang) {
	if (!UI_LANGS.includes(lang) || lang === uiLang) return;
	uiLang = lang;
	try {
		window.localStorage.setItem(UI_LANG_KEY, lang);
	} catch (error) {
		// Best effort only: without storage the choice lasts for this
		// page session, which is still better than refusing to switch.
	}
	applyStaticText();
	refreshRenderedText();
}

/*
 * Re-render the parts of the page that are already on screen. Nothing is
 * re-read from disk and no row is rebuilt, so unsaved edits in the form
 * survive a language switch.
 */
function refreshRenderedText() {
	if (!lastSnapshot || !lastSnapshot.targetText) return;
	updateScopeCopy(currentScope());
	updateSummary(lastSnapshot);
	renderProcguard(lastSnapshot);
	if (lastSnapshot.sceneDebugfsState || lastSnapshot.sceneDebugfsPathsText) {
		updateAutoSceneDebugfsStatus(lastSnapshot);
	}
	updateHealthList();
	renderApps();
	for (const row of $$(".pathRow")) applyPathRowText(row);
	if (lastReport) {
		lastReport = buildReport(lastSnapshot);
		$("#reportOutput").value = lastReport;
	}
}

const actionButtons = [
	"#refreshBtn",
	"#loadAppsBtn",
	"#saveBtn",
	"#pauseBtn",
	"#reloadBtn",
	"#addPathBtn",
	"#runDiagnosticBtn",
	"#validateConfigBtn",
	"#copyReportBtn",
	"#copyReportBtn2",
	"#resetDefaultsBtn",
	"#refreshLogsBtn",
	"#prevLogBtn",
	"#nextLogBtn",
].map($).filter(Boolean);

function shellQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getKsuBridge() {
	if (typeof window !== "undefined" && window.ksu?.exec) return window.ksu;
	if (typeof ksu !== "undefined" && ksu?.exec) return ksu;
	return null;
}

function execShell(command) {
	const bridge = getKsuBridge();
	if (!bridge) throw new Error(t("KernelSU WebUI API 不可用"));

	return new Promise((resolve, reject) => {
		const callbackName = `pathmask_exec_${Date.now()}_${Math.random().toString(16).slice(2)}`;

		window[callbackName] = (errno, stdout, stderr) => {
			delete window[callbackName];
			if (errno && errno !== 0) {
				const err = new Error(stderr || stdout || t("命令失败：{errno}", { errno }));
				// Preserve the raw fields so callers that want to
				// distinguish "command refused" (errno=1, stderr=
				// 'Permission denied') from "command produced no
				// output" can branch on them. Old callers that just
				// look at error.message keep working.
				err.errno = errno;
				err.stderr = stderr || "";
				err.stdout = stdout || "";
				reject(err);
				return;
			}
			resolve(stdout || "");
		};

		try {
			bridge.exec(command, JSON.stringify({}), callbackName);
		} catch (error) {
			try {
				bridge.exec(command, callbackName);
			} catch (fallbackError) {
				delete window[callbackName];
				reject(fallbackError);
			}
		}
	});
}

async function safeExec(command) {
	try {
		return await execShell(command);
	} catch (error) {
		return `ERROR: ${error.message}`;
	}
}

/*
 * Variant of safeExec that returns a structured `{ ok, stdout, errno,
 * stderr, error }` result instead of either-stdout-or-error-string.
 * Used by the diagnostic collector so we can tell users *why* a
 * particular probe came back empty -- "dmesg returned EPERM" is much
 * more actionable than "(未生成)". Old call sites continue to use
 * safeExec.
 */
async function probeExec(command) {
	try {
		const stdout = await execShell(command);
		return { ok: true, stdout, errno: 0, stderr: "", error: "" };
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout || "",
			stderr: error.stderr || "",
			errno: error.errno || 1,
			error: error.message || String(error),
		};
	}
}

function showToast(message) {
	toast.textContent = message;
	toast.hidden = false;
	clearTimeout(showToast.timer);
	showToast.timer = setTimeout(() => {
		toast.hidden = true;
	}, 4200);
}

/*
 * Run a list of async factories with a concurrency cap. execShell()
 * gives every call its own callback name, so concurrent bridge calls
 * are safe by construction -- scheduleBootPolling() and
 * gatherDiagnosticFacts() already rely on that. The cap exists because
 * each call spawns a root shell on the device, and firing all ~32 of
 * refreshConfig()'s reads at once would spike it; 8 at a time still
 * removes almost all of the serial round-trip cost.
 */
async function mapLimit(factories, limit) {
	const results = new Array(factories.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, factories.length)) },
		async () => {
			while (next < factories.length) {
				const index = next++;
				results[index] = await factories[index]();
			}
		},
	);
	await Promise.all(workers);
	return results;
}

const REFRESH_CONCURRENCY = 8;

function setBusy(nextBusy, message) {
	busy = nextBusy;
	for (const button of actionButtons) button.disabled = nextBusy;
	if (message) {
		statusText.textContent = message;
		// A new action supersedes whatever error was on display.
		statusText.classList.remove("statusError");
	}
}

// The status line is the WebUI's main feedback channel, so a failure has
// to be visible there and not only in the transient toast.
function setStatusError(message, error) {
	statusText.textContent = message;
	statusText.classList.add("statusError");
	showToast(error && error.message ? error.message : String(error));
}

async function runAction(message, action) {
	if (busy) {
		showToast(t("正在处理，请稍等"));
		return;
	}

	setBusy(true, message);
	try {
		await action();
	} catch (error) {
		showToast(error.message);
		throw error;
	} finally {
		setBusy(false);
	}
}

async function readFile(path) {
	return execShell(`[ -f ${shellQuote(path)} ] && cat ${shellQuote(path)} || true`);
}

async function readFileOrDefault(path, defaultLines = []) {
	const quoted = shellQuote(path);
	const fallback = defaultLines.length
		? `printf '%s\n' ${defaultLines.map(shellQuote).join(" ")}`
		: "true";
	return execShell(`[ -f ${quoted} ] && cat ${quoted} || ${fallback}`);
}

async function writeLines(path, lines) {
	const clean = lines.map((line) => line.trim()).filter(Boolean);
	const body = clean.length
		? `printf '%s\\n' ${clean.map(shellQuote).join(" ")} > ${shellQuote(path)}`
		: `: > ${shellQuote(path)}`;
	await execShell(`mkdir -p ${shellQuote(CONFIGDIR)}; chmod 0700 ${shellQuote(CONFIGDIR)} 2>/dev/null || true; ${body}`);
}

function linesFromText(text) {
	return text.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
}

function countCsv(text) {
	return text.split(",").map((item) => item.trim()).filter(Boolean).length;
}

function firstLine(text) {
	return (text || "").split(/\r?\n/)[0]?.trim() || "";
}

function normalizeScope(value) {
	const scope = (value || "").trim();
	if (scope === "global" || scope === "deny" || scope === "allow") return scope;
	return "deny";
}

function currentScope() {
	return normalizeScope(
		document.querySelector('input[name="scope"]:checked')?.value ||
		lastSnapshot.scopeText ||
		"deny"
	);
}

function scopeLabel(scope) {
	const normal = normalizeScope(scope);
	if (normal === "global") return t("全局");
	if (normal === "allow") return t("白名单");
	return t("黑名单");
}

function updateScopeCopy(scope) {
	const normal = normalizeScope(scope);
	setText("#uidMetricLabel", normal === "allow" ? t("白名单 UID") : normal === "deny" ? t("黑名单 UID") : t("作用 UID"));
	setText("#packagePanelTitle", normal === "allow" ? t("应用白名单") : normal === "deny" ? t("应用黑名单") : t("应用列表"));
	setText("#scopeListHint", normal === "allow"
		? t("白名单模式：默认隐藏所有应用，勾选的应用不会被隐藏。")
		: normal === "deny"
			? t("黑名单模式：勾选的应用会看不到隐藏路径。")
			: t("全局模式：所有应用都会看不到隐藏路径，应用列表不会参与判断。"));
	updateAllowSystemUidsState(normal);
}

function listModeForScope(scope) {
	return normalizeScope(scope) === "allow" ? "allow" : "deny";
}

function syncActiveUidText() {
	const input = $("#denyUidsInput");
	if (input) uidTexts[activeListMode] = input.value;
}

function setActiveScopeList(scope, options = {}) {
	if (options.syncCurrent !== false) syncActiveUidText();
	activeListMode = listModeForScope(scope);
	if (!packageSelections[activeListMode]) packageSelections[activeListMode] = new Set();
	selectedPackages = packageSelections[activeListMode];
	const input = $("#denyUidsInput");
	if (input) input.value = linesFromText(uidTexts[activeListMode] || "").join("\n");
}

function activeDirectUids() {
	syncActiveUidText();
	return linesFromText(uidTexts[listModeForScope(currentScope())] || "");
}

function sortedPackageList(mode) {
	return [...(packageSelections[mode] || new Set())].sort();
}

// Mirror service.sh's accept-list for boolean *.conf files. The kernel
// param itself is bool 0/1, but we accept the same human-friendly values
// here so a manually-edited conf with "true"/"yes" still loads cleanly.
function parseBoolish(text, fallback = false) {
	const v = firstLine(text).toLowerCase();
	if (v === "") return fallback;
	if (v === "1" || v === "true" || v === "yes" || v === "on" || v === "y") return true;
	if (v === "0" || v === "false" || v === "no" || v === "off" || v === "n") return false;
	return fallback;
}

// Decode the contents of /data/adb/pathmask/syscall_hooks.conf into
// the set of currently-enabled syscall short names. Tolerates either
// a single comma-separated line ("newfstatat,statx") or one token per
// line, in any combination -- service.sh joins both forms before
// passing to insmod, so both should round-trip through here.
//
// Special tokens "all" and "none" reset the running set so that, e.g.,
// a conf containing "all" reads back as every checkbox ticked. An
// empty conf falls back to the recommended default (DEFAULT_SYSCALL_HOOKS).
function parseSyscallHooksText(text) {
	const enabled = new Set();
	let anyToken = false;
	const raw = (text || "").split(/[\s,]+/);
	for (const token of raw) {
		const t = token.trim();
		if (!t || t.startsWith("#")) continue;
		anyToken = true;
		if (t === "all") {
			for (const name of ALL_SYSCALL_HOOKS) enabled.add(name);
			continue;
		}
		if (t === "none") {
			enabled.clear();
			continue;
		}
		if (SYSCALL_HOOK_SET.has(t)) {
			enabled.add(t);
		}
		// Unknown tokens are silently ignored here; service.sh and the
		// kernel both warn separately so we don't double-flag them.
	}
	if (!anyToken) {
		// Empty conf -> use the recommended subset.
		return new Set(DEFAULT_SYSCALL_HOOKS);
	}
	return enabled;
}

function applySyscallHooksToCheckboxes(text) {
	const enabled = parseSyscallHooksText(text);
	for (const cb of document.querySelectorAll('#syscallHooksDetails input[data-syscall]')) {
		cb.checked = enabled.has(cb.dataset.syscall);
	}
}

function collectSyscallHooks() {
	const result = [];
	for (const cb of document.querySelectorAll('#syscallHooksDetails input[data-syscall]')) {
		if (cb.checked) result.push(cb.dataset.syscall);
	}
	return result;
}

// When the master toggle is off the per-syscall list is meaningless --
// service.sh forces "none" anyway -- so disable the checkboxes to make
// the dependency obvious. Keep the <details> expandable either way so
// the user can see what would be enabled if they flip the master back on.
function updateSyscallHooksDisabledState() {
	const master = $("#enableSyscallHooksInput");
	const details = $("#syscallHooksDetails");
	if (!master || !details) return;
	const off = !master.checked;
	for (const cb of details.querySelectorAll('input[data-syscall]')) {
		cb.disabled = off;
	}
	details.classList.toggle("disabled", off);
}

function parseAllowSystemUidsText(text) {
	const enabled = new Set();
	for (const token of (text || "").split(/[\s,]+/)) {
		const uid = token.trim();
		if (!uid || uid.startsWith("#")) continue;
		if (ALLOW_SYSTEM_UID_SET.has(uid)) enabled.add(uid);
	}
	return enabled;
}

function applyAllowSystemUidsToCheckboxes(text) {
	const enabled = parseAllowSystemUidsText(text);
	for (const cb of document.querySelectorAll('#allowSystemUidsDetails input[data-allow-system-uid]')) {
		cb.checked = enabled.has(cb.dataset.allowSystemUid);
	}
}

function collectAllowSystemUids() {
	const result = [];
	for (const cb of document.querySelectorAll('#allowSystemUidsDetails input[data-allow-system-uid]')) {
		if (cb.checked) result.push(cb.dataset.allowSystemUid);
	}
	return result;
}

function updateAllowSystemUidsState(scope = currentScope()) {
	const details = $("#allowSystemUidsDetails");
	if (!details) return;
	const disabled = normalizeScope(scope) !== "allow";
	for (const cb of details.querySelectorAll('input[data-allow-system-uid]')) {
		cb.disabled = disabled;
	}
	details.classList.toggle("disabled", disabled);
}

function setText(selector, value) {
	const node = $(selector);
	if (node) node.textContent = value;
}

function renderPaths(paths) {
	pathList.textContent = "";
	const list = paths.length ? paths : DEFAULT_TARGET_PATHS;
	for (const path of list) addPathRow(path);
}

// A target_path.conf line is one of:
//   - literal:                `/system_ext/app/SoterService`
//   - glob (any segment):     `/dev/???/scene_mode_category`
//   - `dir:` prefix:          hide parent of each match
//   - `any:<group>:` prefix:  member of an OR group; the boot wait
//                             is satisfied if *any* member of the
//                             group resolves. Useful for "Scene 8.x
//                             OR Scene 9.3+" style configs where
//                             one of two paths will exist.
//
// Prefix order is fixed: `any:<group>:dir:<path>`. dir: stays
// adjacent to the path so it's obvious which prefix governs which
// behaviour (group membership vs parent-hiding).
function splitTargetLine(raw) {
	let trimmed = (raw || "").trim();
	let group = "";
	const m = trimmed.match(/^any:([^:]*):(.*)$/);
	if (m) {
		group = m[1];
		trimmed = m[2].trim();
	}
	let useParent = false;
	if (trimmed.startsWith("dir:")) {
		useParent = true;
		trimmed = trimmed.slice(4).trim();
	}
	return { group, useParent, path: trimmed };
}

function joinTargetLine(path, useParent, group) {
	const p = (path || "").trim();
	if (!p) return "";
	let out = useParent ? `dir:${p}` : p;
	const g = (group || "").trim();
	if (g) out = `any:${g}:${out}`;
	return out;
}

function addPathRow(value = "") {
	const { useParent, path, group } = splitTargetLine(value);

	const row = document.createElement("div");
	row.className = "pathRow";

	const input = document.createElement("input");
	input.type = "text";
	input.value = path;

	const groupInput = document.createElement("input");
	groupInput.type = "text";
	groupInput.className = "pathRowGroup";
	groupInput.value = group;

	const dirToggle = document.createElement("label");
	dirToggle.className = "pathRowDirToggle";
	const dirCheckbox = document.createElement("input");
	dirCheckbox.type = "checkbox";
	dirCheckbox.checked = useParent;
	dirToggle.append(dirCheckbox);

	const remove = document.createElement("button");
	remove.type = "button";
	remove.addEventListener("click", () => row.remove());

	// Keep the delete button's accessible name in step with the path.
	input.addEventListener("input", () => applyPathRowText(row));

	row.append(input, groupInput, dirToggle, remove);
	applyPathRowText(row);
	pathList.append(row);
	input.focus();
}

/*
 * The path rows are the one repeated widget that carries translated
 * text, so their labels live here: addPathRow() applies them on
 * creation, and a language switch re-applies them to rows that already
 * exist instead of rebuilding the list (which would drop edits).
 */
function applyPathRowText(row) {
	const inputs = row.querySelectorAll('input[type="text"]');
	const pathInput = inputs[0];
	const groupInput = inputs[1];
	const dirCheckbox = row.querySelector('input[type="checkbox"]');
	const dirToggle = row.querySelector(".pathRowDirToggle");
	const remove = row.querySelector("button");
	if (pathInput) {
		pathInput.placeholder = t("/system/app/example 或 /dev/???/marker");
		/*
		 * The column header row is aria-hidden, and a placeholder stops
		 * being announced once the field holds a value, so every control
		 * here needs a name of its own rather than relying on position.
		 */
		pathInput.setAttribute("aria-label", t("隐藏路径"));
	}
	if (groupInput) {
		groupInput.placeholder = t("组");
		groupInput.title = t("可选 OR 组名。同名组内任一行命中即视为该组满足，所有未分组的行仍需各自存在");
		groupInput.setAttribute("aria-label", t("OR 组名（可选）"));
	}
	if (dirCheckbox) dirCheckbox.setAttribute("aria-label", t("隐藏父目录（dir:）"));
	if (dirToggle) {
		dirToggle.title = t("勾选后隐藏匹配项的父目录（dir:）。对随机父目录场景必须勾选");
	}
	if (remove) {
		remove.textContent = t("删");
		// Name the row being deleted: a list of N paths otherwise exposes
		// N identical "删" buttons that read out the same.
		remove.setAttribute("aria-label", t("删除路径 {0}", [
			(pathInput?.value || "").trim() || t("（空）"),
		]));
	}
}

function collectPaths() {
	return [...pathList.querySelectorAll(".pathRow")]
		.map((row) => {
			const inputs = row.querySelectorAll('input[type="text"]');
			const pathInput = inputs[0];
			const groupInput = inputs[1];
			const dirCheckbox = row.querySelector('input[type="checkbox"]');
			return joinTargetLine(
				pathInput?.value,
				dirCheckbox?.checked,
				groupInput?.value
			);
		})
		.filter(Boolean);
}

function parsePackageLine(line) {
	const match = line.match(/^package:(.+?)\s+uid:(\d+)$/);
	if (!match) return null;
	return { pkg: match[1], uid: match[2] };
}

function renderApps() {
	const query = $("#searchInput").value.trim().toLowerCase();

	const filtered = apps
		.filter((app) => !query || app.pkg.toLowerCase().includes(query))
		.sort((a, b) => {
			const selectedA = selectedPackages.has(a.pkg);
			const selectedB = selectedPackages.has(b.pkg);
			if (selectedA !== selectedB) return selectedA ? -1 : 1;
			return a.pkg.localeCompare(b.pkg);
		});

	// Build off-DOM: appending every row to the live list re-runs layout
	// each time, and with system apps shown the list runs to several
	// hundred rows.
	const fragment = document.createDocumentFragment();
	for (const app of filtered) {
		const row = document.createElement("label");
		row.className = selectedPackages.has(app.pkg) ? "appRow selected" : "appRow";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = selectedPackages.has(app.pkg);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) selectedPackages.add(app.pkg);
			else selectedPackages.delete(app.pkg);
			/*
			 * Update just this row rather than re-rendering the list.
			 * renderApps() sorts selected packages first, so a full
			 * rebuild teleported the row the user had just tapped to the
			 * top -- measured: index 42 -> 0 -- which makes bulk
			 * selection unusable because the next target moves away from
			 * the finger. The selected-first ordering still applies the
			 * next time the list is genuinely rebuilt (search, scope
			 * switch, refresh).
			 */
			row.classList.toggle("selected", checkbox.checked);
			updateHealthList();
		});

		const pkg = document.createElement("div");
		pkg.className = "pkg";
		pkg.textContent = app.pkg;

		const uid = document.createElement("div");
		uid.className = "uid";
		uid.textContent = app.uid;

		row.append(checkbox, pkg, uid);
		fragment.append(row);
	}

	appList.textContent = "";
	appList.append(fragment);
}

function renderHealth(items) {
	const list = $("#healthList");
	list.textContent = "";

	for (const item of items) {
		const li = document.createElement("li");
		li.className = `healthItem ${item.level}`;

		const title = document.createElement("strong");
		title.textContent = item.title;

		const body = document.createElement("span");
		body.textContent = item.body;

		li.append(title, body);
		list.append(li);
	}
}

function updateSummary(snapshot) {
	const loaded = snapshot.moduleText?.trim();
	const legacyLoaded = snapshot.legacyModuleText?.trim();
	const scope = normalizeScope(snapshot.scopeText || "deny");
	const configuredTargetCount = linesFromText(snapshot.targetText || "").length || DEFAULT_TARGET_PATHS.length;
	const resolvedTargetCount = Number.parseInt((snapshot.sysResolvedCount || "").trim(), 10);
	const runtimeAutoCount = linesFromText(snapshot.sceneDebugfsPathsText || "").length;
	const targetCount = loaded && Number.isFinite(resolvedTargetCount)
		? resolvedTargetCount
		: configuredTargetCount + runtimeAutoCount;
	const sysUidCount = countCsv(snapshot.sysDenyUids || "");
	const configUidCount = linesFromText(snapshot.uidText || "").length +
		(scope === "allow" ? parseAllowSystemUidsText(snapshot.allowSystemUidText || "").size : 0);

	setText("#moduleState", loaded ? t("已加载") : legacyLoaded ? t("旧模块已加载") : t("未加载"));
	setText("#scopeState", scopeLabel(scope));
	updateScopeCopy(scope);
	setText("#targetCount", String(targetCount));
	setText("#uidCount", String(sysUidCount || configUidCount));
	statusText.textContent = loaded ? t("模块已加载") : t("模块未加载");
}

function updateAutoSceneDebugfsStatus(snapshot = lastSnapshot) {
	const node = $("#autoSceneDebugfsStatus");
	if (!node) return;
	const configured = parseBoolish(snapshot.autoSceneDebugfsText, DEFAULT_AUTO_SCENE_DEBUGFS);
	const state = snapshot.sceneDebugfsState || {};
	const applied = state.appliedEnabled === 1;
	const paths = linesFromText(snapshot.sceneDebugfsPathsText || "");
	const loaded = !!(snapshot.moduleText || "").trim();

	let message = "";
	if (loaded && configured !== applied) {
		message = configured
			? t("已保存，热重载或重启后开始自动识别")
			: t("已关闭，热重载或重启后移除已识别路径");
	} else if (configured && (state.status === "found" || state.status === "late-found") && paths.length) {
		message = paths.length === 1
			? t("已识别：{path}", { path: paths[0] })
			: t("已识别 {count} 个 /dev debugfs 挂载点", { count: paths.length });
	} else if (configured && state.status === "no-package") {
		message = t("未安装 Scene，已跳过自动识别");
	} else if (configured && state.status === "late-watching") {
		message = t("前台扫描未找到，后台监视 Scene 挂载");
	} else if (configured && state.status === "late-found-pending") {
		message = t("已发现晚启动挂载点，正在受控热重载…");
	} else if (configured && state.status === "late-reload-retry") {
		message = t("已发现挂载点，自动热重载正在重试");
	} else if (configured && state.status === "late-reload-failed") {
		message = t("已发现挂载点，但自动热重载失败");
	} else if (configured && state.status === "watch-timeout") {
		message = t("后台监视超时，可在 Scene 启动后手动热重载");
	} else if (configured && state.status === "waiting") {
		message = t("正在等待 Scene debugfs 挂载点…");
	} else if (configured && state.status === "error") {
		message = t("自动识别失败，请查看诊断日志");
	} else if (configured && state.status === "not-found") {
		message = t("本次未识别到挂载点，其他隐藏路径不受影响");
	} else if (configured) {
		message = t("热重载或重启时自动识别");
	}

	node.textContent = message;
	node.hidden = !message;
}

function updateHealthList() {
	const snapshot = lastSnapshot;
	const items = [];
	const loaded = snapshot.moduleText?.trim();
	const legacyLoaded = snapshot.legacyModuleText?.trim();
	const scope = currentScope();
	const targets = collectPaths();
	const selected = [...selectedPackages];
	const directUids = activeDirectUids();
	const allowSystemUids = scope === "allow" ? collectAllowSystemUids() : [];
	const sysUids = linesFromText((snapshot.sysDenyUids || "").replace(/,/g, "\n"));
	const loadFailCount = Number.parseInt(firstLine(snapshot.loadFailCountText), 10) || 0;
	const loadFailReason = firstLine(snapshot.loadFailReasonText);

	if (loaded) {
		items.push({ level: "ok", title: t("模块已加载"), body: loaded });
	} else if (legacyLoaded) {
		items.push({ level: "warn", title: t("旧 nohello 模块仍在运行"), body: t("卸载旧模块并重启后再安装 PathMask。") });
	} else {
		items.push({ level: "bad", title: t("模块未加载"), body: t("查看脚本日志和内核日志，重点找 ko 缺失、KMI 不匹配、UID 为空或目标路径不存在。") });
	}

	const bootStatusItem = describeBootState(snapshot, !!loaded);
	if (bootStatusItem) {
		items.push(bootStatusItem);
	}

	if ((snapshot.koInfo || "").includes("No such file") || (snapshot.koInfo || "").includes("missing")) {
		items.push({ level: "bad", title: t("pathmask.ko 不存在"), body: t(`{0} 缺失，重新安装模块包。`, [files.ko]) });
	} else {
		items.push({ level: "ok", title: t("模块文件存在"), body: `${files.ko}` });
	}

	const pgKoPresent = (snapshot.procguardKoInfo || "").trim() === "present";
	const pgLoaded = !!(snapshot.procguardModuleText || "").trim();
	const pgEnabled = parseBoolish(snapshot.procguardConfText, false);
	if (!pgKoPresent && pgEnabled) {
		items.push({ level: "warn", title: t("procguard.ko 缺失"), body: t("procguard.conf 为启用但模块包里没有 procguard.ko，隔离防护不可用。") });
	} else if (pgLoaded) {
		items.push({ level: "ok", title: t("隔离防护生效中"), body: t(`procguard 已加载，已拦截 {0} 次 readproc 查询。`, [(snapshot.procguardHits || "").trim() || "0"]) });
	} else if (pgEnabled) {
		items.push({ level: "warn", title: t("隔离防护已启用但未加载"), body: t("在「防护」页重新切换一次开关，或点「保存并热重载」。") });
	} else {
		items.push({ level: "ok", title: t("隔离防护已停用"), body: t("隔离进程仍可遍历 /proc；需要时到「防护」页启用。") });
	}

	if ((scope === "deny" || scope === "allow") && selected.length === 0 && directUids.length === 0 && allowSystemUids.length === 0 && sysUids.length === 0) {
		const listName = scope === "allow" ? t("白名单") : t("黑名单");
		items.push({ level: "bad", title: t(`{0}为空`, [listName]), body: t(`{0} 模式下没有包名或 UID，service.sh 会跳过加载。`, [scope]) });
	} else if (scope === "deny" || scope === "allow") {
		const listName = scope === "allow" ? t("白名单") : t("黑名单");
		const systemPart = scope === "allow" ? t(`，系统 UID {0} 个`, [allowSystemUids.length]) : "";
		items.push({ level: "ok", title: t(`{0}模式有目标`, [listName]), body: t(`包名 {0} 个，直接 UID {1} 个{2}。`, [selected.length, directUids.length, systemPart]) });
	}

	const autoSceneEnabled = !!$("#autoSceneDebugfsInput")?.checked;
	if (targets.length === 0 && !autoSceneEnabled) {
		items.push({ level: "bad", title: t("隐藏路径为空"), body: t("至少保留一个存在的路径，否则模块不会加载。") });
	} else if (targets.length === 0) {
		items.push({ level: "warn", title: t("仅依赖 Scene 自动识别"), body: t("如果等待时间内没有识别到 /dev debugfs，模块将跳过加载。") });
	} else if (snapshot.targetProbeHidden) {
		const resolved = Number.isFinite(snapshot.targetResolvedCount) ? snapshot.targetResolvedCount : -1;
		if (resolved < 0) {
			items.push({ level: "ok", title: t("隐藏路径配置有效"), body: t(`{0} 条路径（当前模式下被自身隐藏，跳过 stat 探测）。`, [targets.length]) });
		} else if (resolved === targets.length) {
			items.push({ level: "ok", title: t("隐藏路径配置有效"), body: t(`内核已解析 {0}/{1} 条路径（当前模式下 stat 会被自身拦截，故跳过用户态探测）。`, [resolved, targets.length]) });
		} else if (resolved === 0) {
			items.push({ level: "warn", title: t("内核未解析到任何路径"), body: t(`配置了 {0} 条路径但内核加载时全部跳过；可能配置变更后未重启或热重载。`, [targets.length]) });
		} else {
			items.push({ level: "warn", title: t("部分路径未解析"), body: t(`内核仅解析了 {0}/{1} 条路径，剩余的在加载时不存在被跳过；查看 dmesg 找具体哪一条。`, [resolved, targets.length]) });
		}
	} else if ((snapshot.targetProbe || "").includes("MISS")) {
		items.push({ level: "warn", title: t("有路径当前不存在"), body: t("不存在的路径会在内核加载时被跳过。") });
	} else {
		items.push({ level: "ok", title: t("隐藏路径配置有效"), body: t(`{0} 条路径。`, [targets.length]) });
	}

	const sceneState = snapshot.sceneDebugfsState || {};
	const sceneApplied = sceneState.appliedEnabled === 1;
	if (loaded && autoSceneEnabled !== sceneApplied) {
		items.push({ level: "warn", title: t("Scene 自动识别配置尚未应用"), body: t("点击“保存并热重载”或重启后生效。") });
	} else if (autoSceneEnabled && (sceneState.status === "found" || sceneState.status === "late-found")) {
		const autoPaths = linesFromText(snapshot.sceneDebugfsPathsText || "");
		items.push({ level: "ok", title: t("Scene debugfs 已自动识别"), body: autoPaths.join("\n") || t("运行时路径已加入内核目标。") });
	} else if (autoSceneEnabled && sceneState.status === "no-package") {
		items.push({ level: "ok", title: t("设备未安装 Scene"), body: t("已跳过自动识别，不等待，也不会匹配其他工具创建的 /dev debugfs。") });
	} else if (autoSceneEnabled && sceneState.status === "late-watching") {
		items.push({ level: "warn", title: t("正在后台等待 Scene 挂载"), body: t("其他有效路径已立即加载；后台发现 Scene debugfs 后会执行一次受控热重载。") });
	} else if (autoSceneEnabled && (sceneState.status === "late-found-pending" || sceneState.status === "late-reload-retry")) {
		items.push({ level: "warn", title: t("已发现晚启动的 Scene debugfs"), body: t("正在尝试将动态路径补充进内核目标。") });
	} else if (autoSceneEnabled && sceneState.status === "late-reload-failed") {
		items.push({ level: "bad", title: t("Scene 自动补充热重载失败"), body: t("挂载点已经识别，但未确认进入内核目标；请手动点击“保存并热重载”。") });
	} else if (autoSceneEnabled && sceneState.status === "watch-timeout") {
		items.push({ level: "warn", title: t("Scene 后台启动监视超时"), body: t("Scene 启动后可手动点击“保存并热重载”。") });
	} else if (autoSceneEnabled && sceneState.status === "not-found") {
		items.push({ level: "warn", title: t("本次未识别到 Scene debugfs"), body: t("其他有效隐藏路径仍会正常加载；可在 Scene 运行后再次热重载。") });
	} else if (autoSceneEnabled && sceneState.status === "error") {
		items.push({ level: "warn", title: t("Scene debugfs 自动识别失败"), body: t("无法读取 mountinfo 或 stat SELinux 上下文，查看脚本日志。") });
	}

	if (loadFailCount >= 3) {
		items.push({ level: "bad", title: t("连续加载失败保护已触发"), body: loadFailReason || t("保存并热重载会重置保护并重新尝试加载。") });
	} else if (loadFailCount > 0) {
		items.push({
			level: "warn",
			title: t("最近发生过加载失败"),
			body: t("{0}/3：{1}", [loadFailCount, loadFailReason || t("查看内核日志。")]),
		});
	}

	for (const message of lastValidation.errors) {
		items.push({ level: "bad", title: t("配置错误"), body: message });
	}
	for (const message of lastValidation.warnings) {
		items.push({ level: "warn", title: t("配置警告"), body: message });
	}
	for (const message of lastValidation.ok) {
		items.push({ level: "ok", title: t("配置校验"), body: message });
	}

	if ((snapshot.moduleFlags || "").includes("disable")) {
		items.push({ level: "bad", title: t("模块被禁用"), body: t("删除 disable 文件或在 KernelSU 管理器中启用模块。") });
	}

	if ((snapshot.legacyConfigInfo || "").trim()) {
		items.push({ level: "warn", title: t("发现旧配置目录"), body: t(`{0} 存在，PathMask 会尝试迁移但不会自动删除。`, [LEGACY_CONFIGDIR]) });
	}

	renderHealth(items);
}

function paginate(text) {
	const lines = (text || "").split(/\r?\n/);
	const pages = [];
	for (let i = 0; i < lines.length; i += LOG_PAGE_LINES) {
		pages.push(lines.slice(i, i + LOG_PAGE_LINES).join("\n"));
	}
	return pages.length ? pages : [""];
}

function renderLogPage() {
	const pages = logPages[activeLog] || [""];
	activeLogPage = Math.max(0, Math.min(activeLogPage, pages.length - 1));
	$("#logOutput").value = pages[activeLogPage] || "";
	$("#logPageInfo").textContent = `${activeLogPage + 1} / ${pages.length}`;
	$("#prevLogBtn").disabled = busy || activeLogPage <= 0;
	$("#nextLogBtn").disabled = busy || activeLogPage >= pages.length - 1;
}

function setLogContent(key, text) {
	logPages[key] = paginate(text);
	if (key === activeLog) activeLogPage = 0;
	renderLogPage();
}

/*
 * Diagnostic redesign (v2.3.3+):
 *
 * The previous buildReport just dumped four blobs of stdout. When a
 * user reported "module not loaded" we got a wall of text where the
 * actual signal -- did service.sh run, what bootState did it reach,
 * is the kernel even allowed to load LKMs, did dmesg return EPERM --
 * was scattered across sections or simply absent. The new pipeline
 * is three-layered:
 *
 *   1. gatherDiagnosticFacts(snapshot)
 *      Runs probe-only shell, parses outputs into a structured `facts`
 *      object that carries typed flags: `moduleLoaded` (bool),
 *      `bootStateName` (string|null), `dmesgAvailable` (bool with
 *      reason if not), `oemKernelTag` (string|null), etc.
 *
 *   2. computeVerdict(facts)
 *      Pure JS rule engine that turns facts into a verdict string +
 *      a list of next-step suggestions. No shell, no DOM. Each rule
 *      is a single if/return so adding a new failure mode is one
 *      bullet point in this function.
 *
 *   3. buildReport(snapshot)
 *      Renders the report top-down: verdict -> key facts -> kernel
 *      env -> config -> next steps -> raw dump. Raw stays for the
 *      developer audience but is now last, not first.
 *
 * The verdict is also rendered into #verdictBox at the top of the
 * Diagnosis tab so the user sees it without copying the report.
 */

const FACT_OK = "ok";
const FACT_BAD = "bad";
const FACT_WARN = "warn";
const FACT_INFO = "info";

const STATUS_GLYPH = {
	[FACT_OK]: "✓",
	[FACT_WARN]: "⚠",
	[FACT_BAD]: "✗",
	[FACT_INFO]: "·",
};

// Detects OEM-modded GKI build tags. When any of these appear in
// `uname -r`, modversions CRC mismatches become substantially more
// likely because the OEM kernel ships a private vmlinux against
// which our DDK-built .ko was not linked. This is purely an
// informational signal -- a clean upstream build also runs fine.
const OEM_KERNEL_HINTS = [
	{ pattern: /abogki/i,        vendor: "OnePlus / OPPO (ColorOS / OxygenOS)" },
	{ pattern: /-perf\b/i,       vendor: "OEM perf build" },
	{ pattern: /oneplus/i,       vendor: "OnePlus" },
	{ pattern: /oxygen/i,        vendor: "OxygenOS" },
	{ pattern: /coloros/i,       vendor: "ColorOS" },
	{ pattern: /miui/i,          vendor: "MIUI" },
	{ pattern: /xiaomi/i,        vendor: "Xiaomi" },
	{ pattern: /-realme/i,       vendor: "Realme" },
	{ pattern: /-vivo/i,         vendor: "vivo" },
	{ pattern: /samsung|exynos/i, vendor: "Samsung / Exynos" },
];

function detectOemKernel(unameR) {
	const text = (unameR || "").toString();
	for (const { pattern, vendor } of OEM_KERNEL_HINTS) {
		const m = text.match(pattern);
		if (m) return { tag: m[0], vendor };
	}
	return null;
}

// Derive the GKI KMI label ("androidXX-Y.Z") from `uname -r`. Used to
// flag a mismatch between the zip the user installed and the kernel
// they're running on.
function detectKmiFromUname(unameR) {
	const m = (unameR || "").match(/(\d+)\.(\d+)\.\d+-(android\d+)/);
	if (!m) return null;
	return `${m[3]}-${m[1]}.${m[2]}`;
}

/*
 * Decode `/proc/sys/kernel/tainted` bitmask into the human-readable
 * flag names (matches kernel/panic.c::TAINT_FLAGS). 4608 = 0x1200 =
 * TAINT_OOT_MODULE (12) + TAINT_LIVEPATCH (9), seen on most OnePlus
 * builds because their stock kernel ships unsigned third-party
 * drivers; PathMask itself also flips OOT_MODULE on insmod, so a
 * non-zero value is not by itself a problem -- we just want to
 * decode it so the user/dev can recognise what's there. Bit names
 * track Linux 6.x; older kernels ignore unknown bits.
 */
const TAINT_FLAGS = [
	{ bit: 0,  name: "P (proprietary)" },
	{ bit: 1,  name: "F (forced)" },
	{ bit: 2,  name: "S (SMP unsafe)" },
	{ bit: 3,  name: "R (forced rmmod)" },
	{ bit: 4,  name: "M (machine check)" },
	{ bit: 5,  name: "B (bad page)" },
	{ bit: 6,  name: "U (userspace)" },
	{ bit: 7,  name: "D (oops)" },
	{ bit: 8,  name: "A (acpi-override)" },
	{ bit: 9,  name: "W (warning)" },
	{ bit: 10, name: "C (staging)" },
	{ bit: 11, name: "I (firmware-workaround)" },
	{ bit: 12, name: "O (out-of-tree, e.g. PathMask itself)" },
	{ bit: 13, name: "E (unsigned)" },
	{ bit: 14, name: "L (soft-lockup)" },
	{ bit: 15, name: "K (livepatch)" },
	{ bit: 16, name: "X (auxiliary)" },
	{ bit: 17, name: "T (struct random)" },
	{ bit: 18, name: "N (test)" },
];

function decodeTaint(value) {
	const v = Number.parseInt(String(value || "").trim(), 10);
	if (!Number.isFinite(v) || v <= 0) return { value: 0, names: [], pretty: t("0 (干净)") };
	const names = TAINT_FLAGS.filter(({ bit }) => v & (1 << bit)).map(({ name }) => name);
	return {
		value: v,
		names,
		pretty: names.length ? `${v} = ${names.join(" + ")}` : t(`{0} (未识别)`, [v]),
	};
}

/*
 * Pull the most actionable single lines out of the `dmesg | grep
 * pathmask|...` blob so the verdict layer can branch on typed
 * signals instead of regex-spelunking. Most loaders print:
 *
 *   pathmask: target[N] /path ino=... dev=...
 *   pathmask: hooked __arm64_sys_xxx
 *   pathmask: skip __arm64_sys_xxx (disabled)
 *   pathmask: <hook> hook fired (first time)
 *   pathmask: loaded -- N target(s) hidden, scope=...
 *
 * Negative signals (CRC mismatch, unresolved symbols, EXECfail) are
 * what we most want to elevate -- if any of these is present the
 * report should turn the OEM-suffix banner from info to actionable.
 */
function summarizeDmesg(text) {
	const lines = (text || "").split(/\r?\n/);
	const sum = {
		hookedSymbols: [],     // ["__arm64_sys_newfstatat", ...]
		skippedSymbols: [],    // ["__arm64_sys_faccessat"]
		hookFiredFirstTime: [],// ["inode_permission", "vfs_getattr"]
		loadedLine: "",        // "pathmask: loaded -- 3 target(s) hidden..."
		targetLines: [],       // ["target[0] /dev/cpuset/scene-daemon ino=346 dev=0:80"]
		notFoundLines: [],     // ["pathmask: /dev/foo not found (err=-2), skip"]
		errorLines: [],        // disagrees, unknown symbol, etc
	};
	// dmesg keeps every load cycle since boot (each hot reload appends
	// its own hooked/fired/target lines), so the same line repeats per
	// cycle. Dedupe while preserving first-seen order for display.
	const pushUnique = (arr, value) => {
		if (!arr.includes(value)) arr.push(value);
	};
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		// strip the kernel timestamp prefix `[   12.345678]` for prettier display
		const clean = line.replace(/^\s*\[\s*\d+\.\d+\]\s*/, "");
		let m;
		if ((m = clean.match(/^pathmask:\s+hooked\s+(\S+)/))) {
			pushUnique(sum.hookedSymbols, m[1]);
		} else if ((m = clean.match(/^pathmask:\s+skip\s+(\S+)\s+\(disabled\)/))) {
			pushUnique(sum.skippedSymbols, m[1]);
		} else if ((m = clean.match(/^pathmask:\s+(\w+(?:\s+\w+)?)\s+hook fired \(first time\)/))) {
			pushUnique(sum.hookFiredFirstTime, m[1]);
		} else if (clean.startsWith("pathmask: loaded -- ")) {
			sum.loadedLine = clean.replace(/^pathmask:\s+/, "");
		} else if ((m = clean.match(/^pathmask:\s+target\[\d+\]\s+(.+)/))) {
			pushUnique(sum.targetLines, m[1]);
		} else if (/pathmask:.*not found|skip/.test(clean) && clean.includes("err=")) {
			pushUnique(sum.notFoundLines, clean.replace(/^pathmask:\s+/, ""));
		} else if (/disagrees about version of symbol|Unknown symbol|invalid module format|exec format error|module_layout/i.test(clean)) {
			sum.errorLines.push(clean);
		}
	}
	return sum;
}

/*
 * Parse the `--- sysfs parameters ---` block from statusLog into a
 * { name: value } map. Used by the verdict to spot stale config
 * (user changed conf but never reloaded; sysfs reflects the last
 * insmod, not the conf on disk).
 */
function parseSysfsParams(statusLog) {
	const params = {};
	const lines = (statusLog || "").split(/\r?\n/);
	let in_section = false;
	for (const line of lines) {
		if (line.startsWith("---")) {
			in_section = line.includes("sysfs parameters");
			continue;
		}
		if (!in_section) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const k = line.slice(0, eq).trim();
		const v = line.slice(eq + 1).trim();
		if (k) params[k] = v;
	}
	return params;
}

function secondsAgo(epoch, now) {
	if (!epoch || !Number.isFinite(epoch) || epoch <= 0) return null;
	const ref = Number.isFinite(now) && now > 0 ? now : Math.floor(Date.now() / 1000);
	const diff = ref - epoch;
	if (diff < 0) return null;
	if (diff < 60) return t(`{0} 秒前`, [diff]);
	if (diff < 3600) return t(`{0} 分钟前`, [Math.floor(diff / 60)]);
	if (diff < 86400) return t(`{0} 小时前`, [Math.floor(diff / 3600)]);
	return t(`{0} 天前`, [Math.floor(diff / 86400)]);
}

// Compare two normalised comma-separated strings irrespective of order
// and whitespace. "a,b,c" == "c, a, b". Used for stale-config detection.
function csvEquivalent(a, b) {
	const norm = (s) => (s || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).sort().join(",");
	return norm(a) === norm(b);
}

/*
 * Run all probes as separate small shell calls. Earlier versions
 * tried to do this in one combined shell with a magic separator
 * (`###PMSEP###`), but on at least one OnePlus / OxygenOS WebUI
 * exec bridge the whole probe came back with empty stdout while
 * other neighbouring `safeExec` calls succeeded -- the symptom was
 * a verdict that swore the module wasn't loaded while the raw
 * /proc/modules dump in the same report clearly showed it was.
 * Splitting the probes makes each round-trip independent: a
 * malformed sub-probe drops one fact, not all of them, and we get
 * per-probe stderr / errno for the few signals (dmesg, getenforce
 * on builds without it) where the failure mode itself is the fact
 * we want to surface to the user.
 *
 * Each probeExec call is sub-ms on a local KSU bridge, so the
 * extra round trips are not noticeable.
 */
async function gatherDiagnosticFacts(snapshot) {
	// One-shot small probes. Each `?? ""` keeps "ERROR: …" out of
	// the typed facts (probeExec already returns a structured
	// object so we don't need that suffix); we use { ok, stdout,
	// stderr } directly.
	const trim = (s) => (s || "").trim();
	const ok = (r) => trim(r && r.ok ? r.stdout : "");

	// Resolve every package in deny_packages.conf to its current UID
	// using the same three strategies service.sh uses on boot
	// (packages.list -> pm list packages -U -> stat data dir). One
	// combined shell so this is a single round-trip; per-package
	// failure becomes an empty UID column. We emit one line per
	// package, format `<pkg>\t<uid>` (empty uid => unresolved). No
	// magic separator between sections needed because the format is
	// already line-oriented and self-describing.
	const denyPackages = linesFromText(snapshot.pkgText || "");
	const denyPackagesShellArg = denyPackages
		.map((p) => p.replace(/[^a-zA-Z0-9._\-]/g, ""))   // sanitise
		.filter(Boolean)
		.map((p) => `'${p}'`)                              // single-quote each
		.join(" ");
	const denyResolveScript = denyPackagesShellArg ? `
resolve_pkg() {
  PKG="$1"
  # 1) /data/system/packages.list (the canonical PM cache)
  if [ -f /data/system/packages.list ]; then
    PUID=$(awk -v p="$PKG" '$1 == p { print $2; exit }' /data/system/packages.list 2>/dev/null)
    if [ -n "$PUID" ] && [ "$PUID" -eq "$PUID" ] 2>/dev/null; then
      printf '%s\\t%s\\n' "$PKG" "$PUID"; return
    fi
  fi
  # 2) pm list packages -U <pkg>
  LINE=$(pm list packages --user 0 -U "$PKG" 2>/dev/null | head -n1)
  case "$LINE" in
    package:"$PKG"' uid:'*)
      PUID="\${LINE##* uid:}"; PUID="\${PUID%% *}"
      if [ -n "$PUID" ] && [ "$PUID" -eq "$PUID" ] 2>/dev/null; then
        printf '%s\\t%s\\n' "$PKG" "$PUID"; return
      fi
      ;;
  esac
  # 3) stat the data dir
  for D in "/data/user/0/$PKG" "/data/data/$PKG"; do
    [ -d "$D" ] || continue
    PUID=$(stat -c '%u' "$D" 2>/dev/null)
    if [ -n "$PUID" ] && [ "$PUID" -eq "$PUID" ] 2>/dev/null; then
      printf '%s\\t%s\\n' "$PKG" "$PUID"; return
    fi
  done
  printf '%s\\t\\n' "$PKG"   # unresolved
}
for PKG in ${denyPackagesShellArg}; do
  resolve_pkg "$PKG"
done
true
` : "true";

	const [
		unameRes,
		taintRes,
		dmesgRestrictRes,
		pagesizeRes,
		selinuxRes,
		kosumRes,
		kosizeRes,
		modulesRes,
		dmesgRes,
		denyResolveRes,
	] = await Promise.all([
		probeExec(`uname -r 2>&1`),
		probeExec(`cat /proc/sys/kernel/tainted 2>&1`),
		probeExec(`cat /proc/sys/kernel/dmesg_restrict 2>&1`),
		probeExec(`getconf PAGE_SIZE 2>&1`),
		probeExec(`getenforce 2>&1`),
		probeExec(`[ -f ${shellQuote(files.ko)} ] && sha1sum ${shellQuote(files.ko)} 2>&1 | awk '{print $1}' || echo missing`),
		probeExec(`[ -f ${shellQuote(files.ko)} ] && stat -c '%s' ${shellQuote(files.ko)} 2>&1 || echo missing`),
		probeExec(`cat /proc/modules 2>&1`),
		probeExec(`dmesg 2>&1 | grep -Ei 'pathmask|procguard|nohello|module_layout|disagrees|unknown symbol|invalid module|exec format' | tail -n 80`),
		probeExec(denyResolveScript),
	]);

	const allModules = ok(modulesRes);
	const ourModule = allModules.split(/\r?\n/).find((l) => l.startsWith("pathmask "));
	const moduleLoaded = !!ourModule;
	const otherLkms = allModules
		.split(/\r?\n/)
		.map((l) => l.split(" ")[0])
		.filter((n) => n && n !== "pathmask" && n !== "procguard" && n !== "nohello");

	const dmesgRaw = ok(dmesgRes);
	const dmesgRestrict = ok(dmesgRestrictRes);
	// dmesg_restrict=1 + empty dmesgRaw == almost certainly EPERM,
	// not "kernel never logged anything about us". Distinguish so
	// the report stops lying about it. Order: explicit error
	// (EPERM in stderr) > dmesg_restrict gate > really empty.
	let dmesgState;
	const dmesgErr = (dmesgRes && (dmesgRes.stderr || "")) || "";
	if (dmesgRaw && !/Operation not permitted|Permission denied/i.test(dmesgRaw)) {
		dmesgState = { available: true, reason: "" };
	} else if (/Operation not permitted|Permission denied/i.test(dmesgErr) ||
	           /Operation not permitted|Permission denied/i.test(dmesgRaw)) {
		dmesgState = {
			available: false,
			reason: t("权限被拒（SELinux / capabilities / dmesg_restrict）"),
		};
	} else if (dmesgRestrict === "1") {
		dmesgState = {
			available: false,
			reason: t("dmesg_restrict=1（系统锁定，root WebUI shell 也无权读，部分 OnePlus / OEM ROM 默认如此）"),
		};
	} else if (!dmesgRes || !dmesgRes.ok) {
		dmesgState = {
			available: false,
			reason: t(`dmesg 命令失败（{0}）`, [(dmesgRes && (dmesgRes.stderr || dmesgRes.error)) || t("未知")]),
		};
	} else {
		dmesgState = { available: false, reason: t("dmesg 无 pathmask 相关行") };
	}

	const koSha = ok(kosumRes);
	const koSize = ok(kosizeRes);
	const unameR = ok(unameRes);
	const oem = detectOemKernel(unameR);
	const kmi = detectKmiFromUname(unameR);
	const taintInfo = decodeTaint(ok(taintRes));
	const dmesgSummary = summarizeDmesg(dmesgRaw);
	const sysfsParams = parseSysfsParams(snapshot.statusLog || "");

	let bootStateName = null;
	let bootStateDetail = null;
	let bootStateUpdated = 0;
	if (snapshot.bootState && snapshot.bootState.state) {
		bootStateName = snapshot.bootState.state;
		bootStateDetail = snapshot.bootState.detail || null;
		bootStateUpdated = Number.parseInt(snapshot.bootState.updated || "0", 10) || 0;
	}
	const nowEpoch = snapshot.nowEpoch || Math.floor(Date.now() / 1000);
	const bootStateAgeStr = secondsAgo(bootStateUpdated, nowEpoch);

	const failCount = Number.parseInt(firstLine(snapshot.loadFailCountText), 10) || 0;
	const failReason = firstLine(snapshot.loadFailReasonText);
	const koMissing = (snapshot.koInfo || "").includes("missing") ||
		(snapshot.koInfo || "").includes("No such file");
	const ksuDisabled = (snapshot.moduleFlags || "").includes("disable");

	// Compare what the user has in conf right now vs what the kernel
	// is actually running with (pulled from sysfs at insmod time).
	// Mismatch == "user changed conf but never reloaded". This is one
	// of the two top false-positive causes of "the module isn't doing
	// anything" support pings.
	const confSyscallHooks = (snapshot.syscallHooksText || "")
		.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).join(",");
	const confEnableSyscallHooks = firstLine(snapshot.enableSyscallHooksText);
	const confScopeMode = (snapshot.scopeText || "").trim();
	const confDirectUids = linesFromText(snapshot.uidText || "");
	const confAllowSystemUids = normalizeScope(confScopeMode) === "allow"
		? [...parseAllowSystemUidsText(snapshot.allowSystemUidText || "")]
		: [];
	const confScopeUids = [...new Set([...confAllowSystemUids, ...confDirectUids])];

	// Resolve configured packages before stale detection so sysfs deny_uids can
	// be compared against the full expected UID set, not just direct UID files.
	const denyPackagesEntries = [];
	const unresolvedDenyPackages = [];
	const resolvedDenyUids = new Set();
	if (denyResolveRes && denyResolveRes.ok) {
		for (const raw of (denyResolveRes.stdout || "").split(/\r?\n/)) {
			const line = raw.replace(/\r$/, "");
			if (!line) continue;
			const tab = line.indexOf("\t");
			if (tab < 0) continue;
			const pkg = line.slice(0, tab).trim();
			const uid = line.slice(tab + 1).trim();
			if (!pkg) continue;
			denyPackagesEntries.push({ pkg, uid: uid || null });
			if (uid) resolvedDenyUids.add(uid);
			else unresolvedDenyPackages.push(pkg);
		}
	}
	const confDenyUidsCsv = [...new Set([...confScopeUids, ...resolvedDenyUids])].join(",");
	const confTargets = linesFromText(snapshot.targetText || "");
	const sysResolvedCount = Number.parseInt(sysfsParams.resolved_count || "-1", 10);
	const sysScopeMode = sysfsParams.scope_mode || "";
	const sysSyscallHooks = sysfsParams.syscall_hooks || "";
	const sysEnableSyscallHooks = sysfsParams.enable_syscall_hooks || "";
	const sysDenyUidsCsv = sysfsParams.deny_uids || "";
	const sysTargetPaths = sysfsParams.target_paths || "";

	const stale = {
		scope: !!moduleLoaded && sysScopeMode && confScopeMode &&
			sysScopeMode !== confScopeMode,
		// enable_syscall_hooks is bool: kernel exposes Y/N in sysfs,
		// conf stores 1/0 (or human variants). Normalise both.
		enableSyscallHooks: !!moduleLoaded && sysEnableSyscallHooks &&
			confEnableSyscallHooks &&
			(sysEnableSyscallHooks === "Y") !== /^(1|true|yes|on)$/i.test(confEnableSyscallHooks),
		// syscall_hooks string: skip when conf is empty (means "fall
		// back to enable_syscall_hooks") because sysfs will then echo
		// the kernel-internal default which differs from "".
		syscallHooks: !!moduleLoaded && confSyscallHooks &&
			!csvEquivalent(sysSyscallHooks, confSyscallHooks),
		denyUids: !!moduleLoaded && confDenyUidsCsv &&
			!csvEquivalent(sysDenyUidsCsv, confDenyUidsCsv),
	};
	const anyStale = stale.scope || stale.enableSyscallHooks ||
		stale.syscallHooks || stale.denyUids;

	// Package resolution was parsed above for stale detection as well as the
	// unresolved/orphan checks below. Three failure modes are worth surfacing:
	// unresolved package names, stale sysfs UIDs, and package UID changes after
	// editing config without hot reload.
	// Orphan UIDs: sysfs has a UID that no current package resolves
	// to. Only meaningful when the module is loaded and we have at
	// least one resolved package (otherwise we'd false-positive when
	// PM is briefly unavailable).
	const sysDenyUidSet = new Set(
		(sysfsParams.deny_uids || "").split(",").map((s) => s.trim()).filter(Boolean),
	);
	const orphanSysDenyUids = (moduleLoaded && resolvedDenyUids.size > 0)
		? [...sysDenyUidSet].filter((u) => !resolvedDenyUids.has(u))
		: [];
	// But there's a third source of UIDs in sysfs: deny_uids.conf
	// (manually-listed UIDs separate from package names). Don't flag
	// those as orphans -- they're legitimate.
	const directDenyUids = new Set(confScopeUids);
	const trueOrphans = orphanSysDenyUids.filter((u) => !directDenyUids.has(u));

	return {
		moduleLoaded,
		moduleLine: ourModule || "",
		bootStateName,
		bootStateDetail,
		bootStateUpdated,
		bootStateAgeStr,
		nowEpoch,
		hasBootState: !!(snapshot.bootStateText && snapshot.bootStateText.trim()),
		failCount,
		failReason,
		koMissing,
		koSha: koSha === "missing" ? "" : koSha,
		koSize: koSize === "missing" ? 0 : Number.parseInt(koSize, 10) || 0,
		ksuDisabled,
		unameR,
		kmi,
		oem,
		pageSize: ok(pagesizeRes),
		selinux: ok(selinuxRes),
		taintInfo,
		otherLkms,
		dmesgRaw,
		dmesgState,
		dmesgSummary,
		sysfsParams,
		writePolicyText: snapshot.writePolicyText || "",
		sysResolvedCount,
		confTargetCount: confTargets.length,
		confSyscallHooks,
		confEnableSyscallHooks,
		stale,
		anyStale,
		denyPackagesEntries,
		unresolvedDenyPackages,
		resolvedDenyUids: [...resolvedDenyUids],
		orphanDenyUids: trueOrphans,
		directDenyUids: [...directDenyUids],
		allowSystemUids: confAllowSystemUids,
	};
}

/*
 * Pure rule engine: facts -> { level, headline, suggestions[] }.
 *
 * Rules go top-down, first match wins. Order matters: we start from
 * the most specific actionable cases (KSU disable flag, fail count
 * >= 3) and end at "module not loaded for unknown reason" so the
 * user is never told to look at "scope_mode is empty" when the
 * actual problem is "the .ko isn't on disk".
 */
function computeVerdict(facts) {
	if (facts.moduleLoaded) {
		// Stack of post-loaded checks. Order matters: stale config
		// dominates over "everything looks fine" because the user
		// is likely about to ask "I changed conf X but it doesn't
		// take effect", which we want to answer up-front.
		if (facts.anyStale) {
			const which = [];
			if (facts.stale.scope)              which.push("scope_mode");
			if (facts.stale.enableSyscallHooks) which.push("enable_syscall_hooks");
			if (facts.stale.syscallHooks)       which.push("syscall_hooks");
			if (facts.stale.denyUids)           which.push("deny_uids");
			return {
				level: FACT_WARN,
				headline: t(`模块在跑，但 conf 已被修改且未热重载（{0}）`, [which.join(", ")]),
				suggestions: [
					t("sysfs 显示的运行参数和 *.conf 不一致；说明你改完 conf 没点「保存并热重载」也没重启。"),
					t("用「保存并热重载」让新配置生效，或者重启。"),
				],
			};
		}
		if (facts.confTargetCount > 0 && facts.sysResolvedCount >= 0 &&
		    facts.sysResolvedCount < facts.confTargetCount) {
			// Glob lines that legitimately match nothing should not
			// trigger this warning, but we don't know glob-vs-literal
			// from this layer. Word it cautiously.
			return {
				level: FACT_WARN,
				headline: t(`模块在跑，但只解析到 {0}/{1} 条目标路径`, [facts.sysResolvedCount, facts.confTargetCount]),
				suggestions: [
					t("剩余路径在加载时不存在，被内核 skip 了。"),
					t("看「dmesg pathmask 相关」段里 'not found (err=...)' 行确认是哪一条。"),
					t("如果是带 ??? 的 glob 行匹配不到，是预期的（路径未生成）；如果是字面路径，多半拼错了或路径被系统改过。"),
				],
			};
		}
		// Unresolved scoped packages: deny/allow mode + at least one package
		// in conf failed to resolve to a UID. In deny mode that means a target
		// app is not hidden; in allow mode it means a trusted app is not exempt.
		const scopeMode = normalizeScope(facts.sysfsParams.scope_mode || "deny");
		const denyMode = scopeMode === "deny";
		const allowMode = scopeMode === "allow";
		const scopedListMode = denyMode || allowMode;
		if (scopedListMode && facts.unresolvedDenyPackages && facts.unresolvedDenyPackages.length > 0) {
			const total = (facts.denyPackagesEntries || []).length;
			const unresolved = facts.unresolvedDenyPackages;
			const listName = allowMode ? t("白名单") : t("黑名单");
			return {
				level: FACT_WARN,
				headline: t(`{0}/{1} 个{2}包名当前无法解析为 UID`, [unresolved.length, total, listName]),
				suggestions: [
					t(`未解析：{0}`, [unresolved.join(", ")]),
					t("包名拼错、应用未安装、或者它是隔离进程（隔离 UID 在 90000-98999 / 99000-99999 范围，PM 查不到）。"),
					t(`对照「应用{0}」面板里实际显示的包名；如果是隔离进程，手填直接 UID。`, [allowMode ? t("白名单") : t("黑名单")]),
					t("修好 conf 后点「保存并热重载」让新的 UID 解析生效。"),
				],
			};
		}
		// Hooks-mounted-but-never-fired warning. If the user
		// genuinely has zero listed UIDs hitting target paths this is
		// false-positive friendly, so we only fire it when the
		// scope is deny + boot_state was old enough that an
		// access-loop should have happened by now (>5 min).
		const ageOldEnough = facts.bootStateUpdated > 0 &&
			(facts.nowEpoch - facts.bootStateUpdated > 300);
		const denyUidCount = (facts.sysfsParams.deny_uids || "").split(",").filter(Boolean).length;
		if (denyMode && denyUidCount > 0 && ageOldEnough &&
		    facts.dmesgState.available &&
		    facts.dmesgSummary.hookFiredFirstTime.length === 0 &&
		    facts.dmesgSummary.loadedLine) {
			return {
				level: FACT_WARN,
				headline: t("hook 已挂上但从未被任何进程触发"),
				suggestions: [
					t(`已经过去 {0}，dmesg 里没有任何 'hook fired (first time)' 行。`, [facts.bootStateAgeStr || t("很久")]),
					t("说明黑名单里的 UID 实际上从未访问过目标路径，或者它们用了 PathMask 还没覆盖的 syscall。"),
					t("如果你期望某个应用被拦截：在 logcat -s pathmask 里搜 hook fired，或者让应用重新启动后重测。"),
				],
			};
		}
		return {
			level: FACT_OK,
			headline: facts.dmesgSummary.hookFiredFirstTime.length > 0
				? t(`PathMask 正在运行（已实战触发：{0}）`, [facts.dmesgSummary.hookFiredFirstTime.join(" + ")])
				: t("PathMask 正在运行"),
			suggestions: [
				t("如果实际表现仍异常（被检测到、目标可见），用「校验配置」检查是否所有目标都被解析。"),
			],
		};
	}

	if (facts.ksuDisabled) {
		return {
			level: FACT_BAD,
			headline: t("模块被 KSU 禁用"),
			suggestions: [
				t(`在 KernelSU 管理器中启用 PathMask，或删除 {0}/disable / remove。`, [MODDIR]),
				t("启用后重启或点「保存并热重载」。"),
			],
		};
	}

	if (facts.koMissing) {
		return {
			level: FACT_BAD,
			headline: t("模块文件 pathmask.ko 缺失"),
			suggestions: [
				t("重新刷入对应 KMI 的 ksu zip。"),
				t(`确认 {0} 在重启后存在。`, [files.ko]),
			],
		};
	}

	if (facts.failCount >= 3) {
		return {
			level: FACT_BAD,
			headline: t(`连续 {0} 次 insmod 失败，已自动跳过加载`, [facts.failCount]),
			suggestions: [
				facts.failReason
					? t(`失败原因：{0}`, [facts.failReason])
					: t("修复底层原因（看下方建议）后再重试。"),
				t("在「快速操作」点「校验配置」找具体原因；修好后用「保存并热重载」即可重置失败保护。"),
			],
		};
	}

	if (facts.failCount >= 1) {
		return {
			level: FACT_WARN,
			headline: t(`最近发生过 {0}/3 次 insmod 失败`, [facts.failCount]),
			suggestions: [
				facts.failReason
					? t(`失败原因：{0}`, [facts.failReason])
					: t("下次开机会再试一次；继续失败将触发跳过保护。"),
				t("如果反复失败，多半是 KMI / OEM 内核 CRC 不兼容（看「内核环境」段）。"),
			],
		};
	}

	if (facts.bootStateName === "skipped-targets-missing") {
		return {
			level: FACT_WARN,
			headline: t("service.sh 等待目标路径超时"),
			suggestions: [
				t("开机时 wait_seconds 内目标路径仍不可见，所以 service.sh 主动跳过加载（这是预期行为，不算 bug）。"),
				t("重启一次通常能恢复（系统第一次冷启动挂载较慢）。"),
				t(`如果反复出现，把 {0}/wait_seconds.conf 调到 90 或 120 秒。`, [CONFIGDIR]),
			],
		};
	}

	if (facts.bootStateName === "skipped-no-uids") {
		const allowMode = (facts.bootStateDetail || "").indexOf("allow mode") !== -1;
		return {
			level: FACT_WARN,
			headline: allowMode ? t("allow 白名单没有解析到任何 UID") : t("deny 模式下没有解析到任何 UID"),
			suggestions: [
				allowMode
					? t("allow 模式至少需要一个能解析到 UID 的白名单应用。")
					: t("deny 模式至少需要一个能解析到 UID 的应用。"),
				t(`在「应用{0}」里勾选应用，或在「直接 UID」里手填，然后保存并重启。`, [allowMode ? t("白名单") : t("黑名单")]),
			],
		};
	}

	if (facts.bootStateName === "skipped-empty-targets") {
		return {
			level: FACT_BAD,
			headline: t("目标路径列表为空"),
			suggestions: [
				t("在「隐藏路径」里至少添加一条路径，否则模块没东西可隐藏，service.sh 会跳过加载。"),
			],
		};
	}

	if (facts.bootStateName === "skipped-fail-guard") {
		return {
			level: FACT_BAD,
			headline: t("失败保护跳过加载"),
			suggestions: [
				t("清掉失败计数（点「保存并热重载」会自动清）后再试。"),
			],
		};
	}

	if (facts.bootStateName === "skipped-legacy-loaded") {
		return {
			level: FACT_BAD,
			headline: t("旧 nohello 模块仍在内核里"),
			suggestions: [
				t("卸载旧的 nohello 模块再装 PathMask，或者直接在 KernelSU 管理器里把 nohello 禁用并重启。"),
			],
		};
	}

	if (facts.bootStateName && facts.bootStateName.startsWith("failed-")) {
		return {
			level: FACT_BAD,
			headline: t(`service.sh 报告 {0}`, [facts.bootStateName]),
			suggestions: [
				t(`详情：{0}`, [facts.bootStateDetail || t("无")]),
				t("重点看下方「dmesg pathmask 相关」段，最常见是 KMI / CRC 不匹配。"),
			],
		};
	}

	if (facts.bootStateName === "loaded" && !facts.moduleLoaded) {
		return {
			level: FACT_BAD,
			headline: t("service.sh 觉得加载成功，但 /proc/modules 里没有 pathmask"),
			suggestions: [
				t("模块加载后又被卸载了，或者 insmod 返回 0 但内核拒绝了模块。"),
				t("重启一次再生成诊断；仍然这样的话看「dmesg pathmask 相关」段（如果可读）。"),
			],
		};
	}

	if (facts.bootStateName && BOOT_WAITING_STATES.has(facts.bootStateName)) {
		return {
			level: FACT_INFO,
			headline: t(`service.sh 仍在 {0} 阶段`, [facts.bootStateName]),
			suggestions: [
				t("等几秒后再生成诊断，让开机脚本走完。"),
			],
		};
	}

	if (facts.bootStateName === "paused") {
		return {
			level: FACT_INFO,
			headline: t("用户从 WebUI 暂停了隐藏"),
			suggestions: [
				t("点「保存并热重载」恢复。"),
			],
		};
	}

	if (!facts.hasBootState) {
		return {
			level: FACT_BAD,
			headline: t("service.sh 似乎从未被调度执行"),
			suggestions: [
				t("没有 /data/adb/pathmask/boot_state 说明开机脚本根本没跑过。"),
				t("先重启一次（这一类问题在 OnePlus / OxygenOS 上首次安装后很常见，重启后正常）。"),
				t("重启后还是这样，确认 KSU 管理器里 PathMask 是「已启用」状态。"),
			],
		};
	}

	return {
		level: FACT_BAD,
		headline: t("模块未加载，原因不在已知列表里"),
		suggestions: [
			t("先重启一次（很多偶发问题靠重启就能解决）。"),
			t("还有问题的话，从 root shell 跑：`insmod /data/adb/modules/pathmask/pathmask.ko ; echo exit=$?` 看完整错误，然后把这份诊断 + 这条命令的输出发给开发者。"),
		],
	};
}

function fmtFactRow(label, level, value) {
	const glyph = STATUS_GLYPH[level] || STATUS_GLYPH[FACT_INFO];
	return `${label.padEnd(14, " ")}${glyph} ${value}`;
}

function buildKeyFacts(facts) {
	const lines = [];
	lines.push(fmtFactRow(
		t("模块加载状态"),
		facts.moduleLoaded ? FACT_OK : FACT_BAD,
		facts.moduleLoaded ? facts.moduleLine : t("未在 /proc/modules"),
	));
	lines.push(fmtFactRow(
		t("模块文件"),
		facts.koMissing ? FACT_BAD : FACT_OK,
		facts.koMissing
			? t(`{0} 缺失`, [files.ko])
			: t(`{0} 字节, sha1={1}`, [facts.koSize, (facts.koSha || "?").slice(0, 12)]),
	));
	lines.push(fmtFactRow(
		t("KSU 启用"),
		facts.ksuDisabled ? FACT_BAD : FACT_OK,
		facts.ksuDisabled ? t("模块被禁用（disable / remove flag）") : t("未被禁用"),
	));
	if (facts.hasBootState) {
		const detail = facts.bootStateDetail ? `（detail=${facts.bootStateDetail}）` : "";
		const age = facts.bootStateAgeStr ? `（${facts.bootStateAgeStr}）` : "";
		lines.push(fmtFactRow(
			t("开机阶段"),
			facts.bootStateName === "loaded" && facts.moduleLoaded ? FACT_OK :
				(facts.bootStateName && facts.bootStateName.startsWith("skipped-") ? FACT_WARN :
					(facts.bootStateName && facts.bootStateName.startsWith("failed-") ? FACT_BAD : FACT_INFO)),
			`${facts.bootStateName || "?"}${age}${detail}`,
		));
	} else {
		lines.push(fmtFactRow(t("开机阶段"), FACT_BAD, t("boot_state 不存在（service.sh 未执行）")));
	}
	const failLevel = facts.failCount >= 3 ? FACT_BAD : facts.failCount > 0 ? FACT_WARN : FACT_OK;
	lines.push(fmtFactRow(
		t("失败计数"),
		failLevel,
		t("{0} / 3{1}", [facts.failCount, facts.failReason ? ` (${facts.failReason})` : ""]),
	));

	// Resolved-vs-configured target count: this is the single most
	// useful "did the kernel actually accept all my targets" signal.
	// Only emit when the module is loaded; if it isn't, sysfs is
	// stale or empty so the comparison is meaningless.
	if (facts.moduleLoaded && facts.confTargetCount > 0 && facts.sysResolvedCount >= 0) {
		const resolved = facts.sysResolvedCount;
		const configured = facts.confTargetCount;
		// resolved > configured happens when Scene auto-discovery adds
		// runtime paths on top of the configured list -- that is a
		// success, not a "skipped targets" warning.
		const note = resolved === configured
			? ""
			: resolved > configured
				? t(`（含 {0} 条运行时自动识别路径）`, [resolved - configured])
				: t("（部分路径加载时不存在被 skip）");
		lines.push(fmtFactRow(
			t("路径解析"),
			resolved >= configured ? FACT_OK : FACT_WARN,
			t(`内核解析 {0} / 配置 {1}{2}`, [resolved, configured, note]),
		));
	}

	// write_op_policy: the running value is the insmod-time sysfs param,
	// the conf value is the persistent file; mismatch means the user
	// switched the policy but has not hot-reloaded yet.
	const writePolicyRunning = ((facts.sysfsParams || {}).write_op_policy || "").trim();
	if (facts.moduleLoaded && writePolicyRunning) {
		const confWritePolicy = (firstLine(facts.writePolicyText || "") || "passthrough").trim();
		const writePolicyStale = confWritePolicy !== writePolicyRunning;
		lines.push(fmtFactRow(
			t("写入伪装策略"),
			writePolicyStale ? FACT_WARN : FACT_OK,
			t("{0}{1}", [
				writePolicyRunning,
				writePolicyStale ? t("（配置为 {0}，未热重载）", [confWritePolicy]) : "",
			]),
		));
	}

	// Hook fired: shows whether any listed UID has actually triggered
	// our hooks since boot. Empty list on a freshly-loaded module is
	// fine; empty list 5+ minutes after load is suspicious.
	if (facts.moduleLoaded && facts.dmesgState.available) {
		const fired = facts.dmesgSummary.hookFiredFirstTime || [];
		const hooked = facts.dmesgSummary.hookedSymbols || [];
		const skipped = facts.dmesgSummary.skippedSymbols || [];
		if (fired.length > 0) {
			lines.push(fmtFactRow(
				t("hook 命中"),
				FACT_OK,
				t(`已实战触发：{0}`, [fired.join(", ")]),
			));
		} else if (hooked.length > 0) {
			lines.push(fmtFactRow(
				t("hook 命中"),
				FACT_INFO,
				t(`挂载 {0} 个，但 dmesg 中尚未见任何 'fired (first time)' 行（开机不久或作用 UID 未访问目标）`, [hooked.length]),
			));
		}
		if (skipped.length > 0) {
			lines.push(fmtFactRow(
				t("主动跳过的 hook"),
				FACT_INFO,
				skipped.join(", "),
			));
		}
	}

	// Stale-config indicators: each stale flag gets its own line so
	// the user can see precisely which knob is out of sync.
	if (facts.moduleLoaded && facts.anyStale) {
		const labels = {
			scope:               "scope_mode",
			enableSyscallHooks:  "enable_syscall_hooks",
			syscallHooks:        "syscall_hooks",
			denyUids:            "deny_uids",
		};
		for (const [key, label] of Object.entries(labels)) {
			if (!facts.stale[key]) continue;
			lines.push(fmtFactRow(
				`stale: ${label}`,
				FACT_WARN,
				t("conf 已修改但内核仍在用旧值（点「保存并热重载」）"),
			));
		}
	}

	// Package -> UID map. We render this whenever any package
	// is listed in conf, even when the module isn't loaded, because
	// "did this package even resolve" is the question users have
	// most often. Layout: <pkg> -> uid (or '(未解析)'). Compact view
	// shows up to 8 packages then "...+N more"; full list is in
	// the report's raw config dump anyway.
	if (facts.denyPackagesEntries && facts.denyPackagesEntries.length > 0) {
		const total = facts.denyPackagesEntries.length;
		const unresolved = facts.unresolvedDenyPackages.length;
		const headLevel = unresolved === 0 ? FACT_OK :
			(unresolved === total ? FACT_BAD : FACT_WARN);
		const summary = unresolved === 0
			? t(`{0}/{1} 个包名全部解析成功`, [total, total])
			: t(`{0}/{1} 个包名解析成功，{2} 个失败`, [total - unresolved, total, unresolved]);
		lines.push(fmtFactRow(t("包名→UID 解析"), headLevel, summary));
		const preview = facts.denyPackagesEntries.slice(0, 8).map((e) => {
			return t("  {0} -> {1}", [e.pkg, e.uid || t("(未解析)")]);
		});
		for (const p of preview) lines.push(p);
		if (total > 8) {
			lines.push(t(`  …+{0} 个未列出`, [total - 8]));
		}
	}

	// Orphan UIDs in sysfs: kernel deny_uids has scoped UIDs that don't
	// match any package now in conf and aren't in deny_uids.conf
	// either. Most often means user removed a package from conf
	// but didn't hot-reload, so kernel still hides for the old UID.
	if (facts.orphanDenyUids && facts.orphanDenyUids.length > 0) {
		lines.push(fmtFactRow(
			t("sysfs 孤立 UID"),
			FACT_WARN,
			t(`{0}（来源不明，多半是删过包名但没热重载）`, [facts.orphanDenyUids.join(", ")]),
		));
	}

	const otherCount = facts.otherLkms.length;
	const otherSummary = otherCount === 0
		? t("无")
		: t("{0}{1}", [
			facts.otherLkms.slice(0, 5).join(", "),
			otherCount > 5 ? t(" … (共 {0} 个)", [otherCount]) : "",
		]);
	lines.push(fmtFactRow(
		t("其他 LKM"),
		otherCount > 0 ? FACT_OK : FACT_INFO,
		otherCount > 0 ? t("{0}（说明本机能加载 LKM）", [otherSummary]) : otherSummary,
	));
	return lines.join("\n");
}

/*
 * Render the parsed dmesgSummary into a structured block instead of
 * dumping the 80 raw grep lines. The raw block is appended at the
 * bottom for completeness, but the grouped summary is what users /
 * developers will actually read.
 */
function buildDmesgSection(summary, raw) {
	if (!summary) return raw || t("(dmesg 中没有 pathmask 相关行)");
	const out = [];
	if (summary.loadedLine) {
		out.push("[load summary]");
		out.push("  " + summary.loadedLine);
	}
	if (summary.targetLines.length) {
		out.push("[target inodes]");
		for (const t of summary.targetLines) out.push("  " + t);
	}
	if (summary.hookedSymbols.length) {
		out.push("[hooked symbols]");
		out.push("  " + summary.hookedSymbols.join(", "));
	}
	if (summary.skippedSymbols.length) {
		out.push("[skipped symbols (disabled by user)]");
		out.push("  " + summary.skippedSymbols.join(", "));
	}
	if (summary.hookFiredFirstTime.length) {
		out.push("[hook fired (first time)]");
		out.push("  " + summary.hookFiredFirstTime.join(", "));
	}
	if (summary.notFoundLines.length) {
		out.push("[paths not found at insmod]");
		for (const l of summary.notFoundLines) out.push("  " + l);
	}
	if (summary.errorLines.length) {
		out.push("[errors / kernel rejection]");
		for (const l of summary.errorLines) out.push("  " + l);
	}
	if (out.length === 0) {
		return raw && raw.trim() ? raw : t("(dmesg 中没有 pathmask 相关行)");
	}
	out.push("");
	out.push(t("--- raw dmesg pathmask 相关 ---"));
	out.push(raw && raw.trim() ? raw : t("(空)"));
	return out.join("\n");
}

function buildKernelEnv(facts) {
	const lines = [];
	lines.push(fmtFactRow(t("内核版本"), FACT_INFO, facts.unameR || t("(读不到 uname -r)")));
	if (facts.kmi) {
		lines.push(fmtFactRow(t("内核 KMI"), FACT_INFO, t(`{0}（请确认安装的 zip 也是这个 KMI）`, [facts.kmi])));
	}
	if (facts.oem) {
		// Only elevate to ⚠ when there's actual evidence of CRC
		// trouble in dmesg (or when the module is failed-to-load
		// and we have no dmesg to check). On a working install
		// "abogki" / "oneplus" / etc. is harmless, and pinning a
		// permanent ⚠ on every OnePlus user's report just trains
		// them to ignore warnings.
		const dmesgHasCrcError = (facts.dmesgSummary && facts.dmesgSummary.errorLines &&
			facts.dmesgSummary.errorLines.length > 0);
		const elevate = !facts.moduleLoaded && (dmesgHasCrcError || !facts.dmesgState.available);
		const oemMessage = elevate
			? t(`{0}（{1}）— OEM 改过 GKI；dmesg 可见 CRC / unknown symbol 错误，多半就是这里不兼容。换 SukiSU / KernelPatch 或自编内核试试`, [facts.oem.tag, facts.oem.vendor])
			: t(`{0}（{1}）— OEM 改过 GKI，CRC 理论上可能不兼容，但当前模块跑得正常`, [facts.oem.tag, facts.oem.vendor]);
		lines.push(fmtFactRow(t("OEM 后缀"), elevate ? FACT_WARN : FACT_INFO, oemMessage));
	}
	if (facts.pageSize) {
		lines.push(fmtFactRow(
			"Page size",
			FACT_INFO,
			t(`{0}（如果 insmod 报 invalid module format，多半是 page size 不一致）`, [facts.pageSize]),
		));
	}
	if (facts.selinux) {
		lines.push(fmtFactRow("SELinux", FACT_INFO, facts.selinux));
	}
	if (facts.taintInfo) {
		lines.push(fmtFactRow(
			t("内核污染位"),
			facts.taintInfo.value === 0 ? FACT_OK : FACT_INFO,
			facts.taintInfo.pretty,
		));
	}
	lines.push(fmtFactRow(
		t("dmesg 权限"),
		facts.dmesgState.available ? FACT_OK : FACT_WARN,
		facts.dmesgState.available ? t("可读") : facts.dmesgState.reason,
	));
	if (facts.dmesgSummary && facts.dmesgSummary.errorLines.length > 0) {
		lines.push(fmtFactRow(
			t("内核拒绝信号"),
			FACT_BAD,
			t(`dmesg 含 {0} 行 CRC / unknown symbol / invalid module 错误，看下方 dmesg 段获取具体行`, [facts.dmesgSummary.errorLines.length]),
		));
	}
	return lines.join("\n");
}

function buildProcguardSection(snapshot) {
	const koPresent = (snapshot.procguardKoInfo || "").trim() === "present";
	const loaded = !!(snapshot.procguardModuleText || "").trim();
	const enabled = parseBoolish(snapshot.procguardConfText, false);
	const lines = [
		t("procguard.ko: {0}", [koPresent ? t("存在") : t("缺失")]),
		t("procguard.conf: {0}", [enabled ? t("1（启用）") : t("0（停用）")]),
		t(`已加载: {0}`, [loaded ? t("是") : t("否")]),
	];
	if (loaded) {
		lines.push(`blocked_hits: ${(snapshot.procguardHits || "").trim() || "0"}`);
		lines.push(`missed: ${(snapshot.procguardMissed || "").trim() || "0"}`);
		lines.push(`target_gid: ${(snapshot.procguardGid || "").trim() || "3009"}`);
	}
	return lines.join("\n");
}

function buildReport(snapshot = lastSnapshot) {
	const facts = snapshot.facts;
	const verdict = snapshot.verdict;
	if (!facts || !verdict) {
		// First call before refreshDiagnostics has populated facts.
		// Return a stub so the textarea isn't empty.
		return t("PathMask 诊断报告\n（点「生成诊断」后这里会出现可复制报告）");
	}

	const parts = [
		t("PathMask 诊断报告"),
		t(`生成时间: {0}`, [new Date().toLocaleString()]),
		t(`模块版本: {0}`, [snapshot.moduleProp || "?"]),
		"",
		t("=== 结论 ==="),
		`${STATUS_GLYPH[verdict.level] || "·"} ${verdict.headline}`,
		...(verdict.suggestions.length
			? ["", t("建议："), ...verdict.suggestions.map((s, i) => `  ${i + 1}. ${s}`)]
			: []),
		"",
		t("=== 关键事实 ==="),
		buildKeyFacts(facts),
		"",
		t("=== 内核环境 ==="),
		buildKernelEnv(facts),
		"",
		t("=== 配置文件 ==="),
		snapshot.configLog || t("(未采集)"),
		"",
		t("=== procguard（隔离防护） ==="),
		buildProcguardSection(snapshot),
		"",
		t("=== 脚本日志 logcat ==="),
		snapshot.scriptLog && !/^ERROR:/.test(snapshot.scriptLog) && snapshot.scriptLog.trim()
			? snapshot.scriptLog
			: t("(无 pathmask 相关 logcat{0})", [
				snapshot.scriptLogReason ? t("；{0}", [snapshot.scriptLogReason]) : "",
			]),
		"",
		t("=== dmesg pathmask 相关 ==="),
		facts.dmesgState.available
			? buildDmesgSection(facts.dmesgSummary, facts.dmesgRaw)
			: t(`(dmesg 不可读：{0})`, [facts.dmesgState.reason]),
		"",
		t("=== 原始数据 ==="),
		t("--- 模块状态 ---"),
		snapshot.statusLog || t("(未采集)"),
	];
	return parts.join("\n");
}

// Render verdict + key facts directly into the Diagnosis tab so the
// user sees actionable info without copying the report. The same
// content is duplicated into #reportOutput for those who do copy.
function renderVerdictPanel(snapshot) {
	const box = $("#verdictBox");
	if (!box) return;
	const verdict = snapshot && snapshot.verdict;
	const facts = snapshot && snapshot.facts;
	if (!verdict || !facts) {
		box.hidden = true;
		box.textContent = "";
		return;
	}
	box.hidden = false;
	box.dataset.level = verdict.level;
	box.textContent = "";

	const head = document.createElement("div");
	head.className = "verdictHead";
	head.textContent = `${STATUS_GLYPH[verdict.level] || "·"}  ${verdict.headline}`;
	box.append(head);

	if (verdict.suggestions.length) {
		const ol = document.createElement("ol");
		ol.className = "verdictSuggestions";
		for (const s of verdict.suggestions) {
			const li = document.createElement("li");
			li.textContent = s;
			ol.append(li);
		}
		box.append(ol);
	}
}

async function copyText(text) {
	if (!text) {
		showToast(t("没有可复制内容"));
		return;
	}

	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			showToast(t("已复制"));
			return;
		} catch (error) {
			/* Fall back to textarea copy below. */
		}
	}

	/*
	 * Fallback for WebViews without an async clipboard (navigator.clipboard
	 * needs a secure context). The off-screen positioning keeps the page
	 * from scrolling to the temporary textarea, and we report what
	 * execCommand actually returned instead of always claiming success.
	 */
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.top = "-1000px";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	area.setSelectionRange(0, area.value.length);
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch (error) {
		copied = false;
	}
	area.remove();
	showToast(copied ? t("已复制") : t("复制失败，请长按文本框手动复制"));
}

async function loadApps() {
	statusText.textContent = t("正在加载应用...");
	const showSystem = $("#showSystemInput").checked;
	const command = showSystem ? "pm list packages -U" : "pm list packages -U -3";
	const output = await execShell(command);
	apps = output.split(/\r?\n/)
		.map(parsePackageLine)
		.filter(Boolean)
		.sort((a, b) => a.pkg.localeCompare(b.pkg));
	renderApps();
	showToast(t(`已加载 {0} 个应用`, [apps.length]));
}

function renderProcguard(snapshot) {
	const input = $("#procguardEnableInput");
	const stats = $("#procguardStats");
	if (!input || !stats) return;
	const koPresent = (snapshot.procguardKoInfo || "").trim() === "present";
	const loaded = !!(snapshot.procguardModuleText || "").trim();
	const enabled = parseBoolish(snapshot.procguardConfText, false);
	input.disabled = !koPresent;
	input.checked = enabled || loaded;
	if (!koPresent) {
		stats.textContent = t("当前模块包未包含 procguard.ko，防护不可用");
		return;
	}
	if (loaded) {
		const hits = (snapshot.procguardHits || "").trim() || "0";
		const missed = (snapshot.procguardMissed || "").trim() || "0";
		const gid = (snapshot.procguardGid || "").trim() || "3009";
		stats.textContent = t(`procguard 已加载：已拦截 {0} 次隔离进程对 gid {1} 的查询（missed={2}）`, [hits, gid, missed]);
	} else if (enabled) {
		stats.textContent = t("已启用但尚未加载：重新切换一次开关或热重载后生效");
	} else {
		stats.textContent = t("已停用：隔离进程仍可遍历 /proc");
	}
}

// Enable  = persist flag + full reload of BOTH modules via service.sh
//           (it re-reads procguard.conf and loads what is enabled).
// Disable = persist flag + unload procguard only; pathmask keeps running.
async function setProcguardEnabled(enable) {
	await writeLines(files.procguardConf, [enable ? "1" : "0"]);
	if (enable) {
		const output = await execShell(
			`if grep -q '^${PROCGUARD_MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${PROCGUARD_MODULE_NAME} 2>/dev/null || true; fi; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME} || exit 20; fi; PATHMASK_RESET_FAIL_GUARD=1 PATHMASK_IGNORE_FAIL_GUARD=1 PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=5 sh ${shellQuote(files.service)}; dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
		);
		setLogContent("kernel", output);
		await refreshDiagnostics();
		showToast(t("隔离防护已启用"));
	} else {
		await execShell(`if grep -q '^${PROCGUARD_MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${PROCGUARD_MODULE_NAME}; fi; true`);
		showToast(t("隔离防护已停用"));
	}
	await refreshConfig();
}

async function refreshConfig() {
	/*
	 * Every one of these is an independent read, so they are dispatched
	 * concurrently (capped by REFRESH_CONCURRENCY). They used to be
	 * awaited one after another: ~32 serial round-trips through the
	 * KernelSU bridge on every page load, every 刷新, and after every
	 * save/reload -- measured maxInFlight=1 with 33 calls per run. Order
	 * below matches the destructuring order exactly.
	 */
	const [
		targetText,
		hideText,
		scopeText,
		denyPkgText,
		allowPkgText,
		denyUidText,
		allowUidText,
		allowSystemUidText,
		waitText,
		enableSyscallHooksText,
		syscallHooksText,
		autoSceneDebugfsText,
		sceneDebugfsPathsText,
		sceneDebugfsStateText,
		bootStateText,
		moduleText,
		legacyModuleText,
		sysDenyUids,
		sysResolvedCount,
		procguardConfText,
		writePolicyText,
		procguardModuleText,
		procguardKoInfo,
		procguardHits,
		procguardMissed,
		procguardGid,
		koInfo,
		moduleFlags,
		legacyConfigInfo,
		loadFailCountText,
		loadFailReasonText,
		nowText,
	] = await mapLimit([
		() => readFile(files.targets),
		() => readFile(files.hideDirents),
		() => readFile(files.scope),
		() => readFile(files.denyPackages),
		() => readFile(files.allowPackages),
		() => readFile(files.denyUids),
		() => readFile(files.allowUids),
		() => readFileOrDefault(files.allowSystemUids, DEFAULT_ALLOW_SYSTEM_UIDS),
		() => readFile(files.waitSeconds),
		() => readFile(files.enableSyscallHooks),
		() => readFile(files.syscallHooks),
		() => readFile(files.autoSceneDebugfs),
		() => readFile(files.sceneDebugfsPaths),
		() => readFile(files.sceneDebugfsState),
		() => readFile(files.bootState),
		() => safeExec(`grep '^${MODULE_NAME} ' /proc/modules || true`),
		() => safeExec(`grep '^${LEGACY_MODULE_NAME} ' /proc/modules || true`),
		() => safeExec(`[ -f /sys/module/${MODULE_NAME}/parameters/deny_uids ] && cat /sys/module/${MODULE_NAME}/parameters/deny_uids || true`),
		() => safeExec(`[ -f /sys/module/${MODULE_NAME}/parameters/resolved_count ] && cat /sys/module/${MODULE_NAME}/parameters/resolved_count || true`),
		() => readFile(files.procguardConf),
		() => readFile(files.writeOpPolicy),
		() => safeExec(`grep '^${PROCGUARD_MODULE_NAME} ' /proc/modules || true`),
		() => safeExec(`[ -f ${shellQuote(files.procguardKo)} ] && echo present || echo missing`),
		() => safeExec(`[ -f /sys/module/${PROCGUARD_MODULE_NAME}/parameters/blocked_hits ] && cat /sys/module/${PROCGUARD_MODULE_NAME}/parameters/blocked_hits || true`),
		() => safeExec(`[ -f /sys/module/${PROCGUARD_MODULE_NAME}/parameters/missed ] && cat /sys/module/${PROCGUARD_MODULE_NAME}/parameters/missed || true`),
		() => safeExec(`[ -f /sys/module/${PROCGUARD_MODULE_NAME}/parameters/target_gid ] && cat /sys/module/${PROCGUARD_MODULE_NAME}/parameters/target_gid || true`),
		() => safeExec(`[ -f ${shellQuote(files.ko)} ] && ls -l ${shellQuote(files.ko)} || echo missing`),
		() => safeExec(`ls -1 ${shellQuote(MODDIR)}/disable ${shellQuote(MODDIR)}/remove 2>/dev/null || true`),
		() => safeExec(`[ -d ${shellQuote(LEGACY_CONFIGDIR)} ] && echo ${shellQuote(LEGACY_CONFIGDIR)} || true`),
		() => readFile(files.failCount),
		() => readFile(files.failReason),
		() => safeExec(`date +%s 2>/dev/null || echo 0`),
	], REFRESH_CONCURRENCY);

	renderPaths(linesFromText(targetText));
	$("#hideDirentsInput").checked = (hideText.trim() || "1") !== "0";
	$("#enableSyscallHooksInput").checked = parseBoolish(enableSyscallHooksText, true);
	$("#autoSceneDebugfsInput").checked = parseBoolish(autoSceneDebugfsText, DEFAULT_AUTO_SCENE_DEBUGFS);
	applySyscallHooksToCheckboxes(syscallHooksText);
	updateSyscallHooksDisabledState();
	const scope = normalizeScope(scopeText.trim() || "deny");
	const scopeInput = document.querySelector(`input[name="scope"][value="${scope}"]`);
	if (scopeInput) scopeInput.checked = true;
	const writePolicyRaw = (writePolicyText || "").trim() || "passthrough";
	const writePolicy = ["passthrough", "eacces", "enoent"].includes(writePolicyRaw) ? writePolicyRaw : "passthrough";
	const writePolicyInput = document.querySelector(`input[name="writePolicy"][value="${writePolicy}"]`);
	if (writePolicyInput) writePolicyInput.checked = true;
	applyAllowSystemUidsToCheckboxes(allowSystemUidText);
	updateAllowSystemUidsState(scope);
	const denyPackageLines = linesFromText(denyPkgText);
	const allowPackageLines = linesFromText(allowPkgText);
	packageSelections = {
		deny: new Set(denyPackageLines.length ? denyPackageLines : DEFAULT_DENY_PACKAGES),
		allow: new Set(allowPackageLines),
	};
	uidTexts = {
		deny: linesFromText(denyUidText).join("\n"),
		allow: linesFromText(allowUidText).join("\n"),
	};
	setActiveScopeList(scope, { syncCurrent: false });
	const pkgText = scope === "allow" ? allowPkgText : denyPkgText;
	const uidText = scope === "allow" ? allowUidText : denyUidText;
	updateScopeCopy(scope);
	$("#waitSecondsInput").value = parseWaitSeconds(waitText);
	renderApps();

	lastSnapshot = {
		...lastSnapshot,
		targetText,
		hideText,
		scopeText,
		pkgText,
		uidText,
		denyPkgText,
		allowPkgText,
		denyUidText,
		allowUidText,
		allowSystemUidText,
		waitText,
		enableSyscallHooksText,
		syscallHooksText,
		autoSceneDebugfsText,
		sceneDebugfsPathsText,
		sceneDebugfsStateText,
		sceneDebugfsState: parseSceneDebugfsState(sceneDebugfsStateText),
		bootStateText,
		bootState: parseBootState(bootStateText),
		nowEpoch: Number.parseInt((nowText || "0").trim(), 10) || 0,
		moduleText,
		legacyModuleText,
		sysDenyUids,
		sysResolvedCount,
		procguardConfText,
		procguardModuleText,
		procguardKoInfo,
		procguardHits,
		procguardMissed,
		procguardGid,
		writePolicyText,
		koInfo,
		moduleFlags,
		legacyConfigInfo,
		loadFailCountText,
		loadFailReasonText,
	};

	await refreshTargetProbe();
	updateSummary(lastSnapshot);
	renderProcguard(lastSnapshot);
	updateAutoSceneDebugfsStatus(lastSnapshot);
	updateHealthList();
	scheduleBootPolling(lastSnapshot.bootState);
}

function parseWaitSeconds(text) {
	const value = Number.parseInt(firstLine(text), 10);
	if (Number.isFinite(value) && value > 0) return value;
	return DEFAULT_WAIT_SECONDS;
}

function parseBootState(text) {
	const out = { state: "", updated: 0, deadline: 0, detail: "" };
	if (!text) return out;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx);
		const value = line.slice(idx + 1);
		if (key === "state") out.state = value;
		else if (key === "updated") out.updated = Number.parseInt(value, 10) || 0;
		else if (key === "deadline") out.deadline = Number.parseInt(value, 10) || 0;
		else if (key === "detail") out.detail = value;
	}
	return out;
}

function parseSceneDebugfsState(text) {
	const out = { enabled: 0, appliedEnabled: 0, status: "", packageStatus: "", count: 0, updated: 0, detail: "" };
	for (const rawLine of (text || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx);
		const value = line.slice(idx + 1);
		if (key === "enabled") out.enabled = Number.parseInt(value, 10) || 0;
		else if (key === "applied_enabled") out.appliedEnabled = Number.parseInt(value, 10) || 0;
		else if (key === "status") out.status = value;
		else if (key === "package_status") out.packageStatus = value;
		else if (key === "count") out.count = Number.parseInt(value, 10) || 0;
		else if (key === "updated") out.updated = Number.parseInt(value, 10) || 0;
		else if (key === "detail") out.detail = value;
	}
	return out;
}

function stopBootPolling() {
	if (bootPollHandle) {
		clearInterval(bootPollHandle);
		bootPollHandle = null;
	}
}

function scheduleBootPolling(bootState) {
	const bootWaiting = !!bootState && BOOT_WAITING_STATES.has(bootState.state);
	const sceneWaiting = SCENE_BACKGROUND_STATES.has(lastSnapshot.sceneDebugfsState?.status || "");
	if (!bootWaiting && !sceneWaiting) {
		stopBootPolling();
		return;
	}
	if (bootPollHandle) return;
	bootPollHandle = setInterval(() => {
		if (busy) return;
		Promise.all([
			readFile(files.bootState),
			readFile(files.sceneDebugfsState),
			readFile(files.sceneDebugfsPaths),
			safeExec(`grep '^${MODULE_NAME} ' /proc/modules || true`),
		]).then(([text, sceneText, scenePathsText, moduleText]) => {
			const next = parseBootState(text);
			const nextScene = parseSceneDebugfsState(sceneText);
			const wasWaiting = lastSnapshot.bootState && BOOT_WAITING_STATES.has(lastSnapshot.bootState.state);
			const wasSceneWaiting = SCENE_BACKGROUND_STATES.has(lastSnapshot.sceneDebugfsState?.status || "");
			lastSnapshot.bootStateText = text;
			lastSnapshot.bootState = next;
			lastSnapshot.sceneDebugfsStateText = sceneText;
			lastSnapshot.sceneDebugfsState = nextScene;
			lastSnapshot.sceneDebugfsPathsText = scenePathsText;
			lastSnapshot.moduleText = moduleText;
			return safeExec(`date +%s 2>/dev/null || echo 0`).then((nowText) => {
				lastSnapshot.nowEpoch = Number.parseInt((nowText || "0").trim(), 10) || 0;
				updateSummary(lastSnapshot);
				updateAutoSceneDebugfsStatus(lastSnapshot);
				updateHealthList();
				const stillBootWaiting = BOOT_WAITING_STATES.has(next.state);
				const stillSceneWaiting = SCENE_BACKGROUND_STATES.has(nextScene.status);
				if (!stillBootWaiting && !stillSceneWaiting) {
					stopBootPolling();
					// Transition: was waiting, now terminal. Run one
					// auto-diagnostic so the verdict box reflects the
					// final boot outcome without the user having to
					// click. Guarded by `wasWaiting` so we don't fire
					// twice in a row if the poll catches the state
					// after a previous tick already saw it terminal.
					if (wasWaiting || wasSceneWaiting) {
						autoRunDiagnostic(wasSceneWaiting
							? t("自动诊断中（Scene 后台监视完成）...")
							: t("自动诊断中（开机完成）..."));
					}
				}
			});
		}).catch(() => {});
	}, BOOT_POLL_INTERVAL_MS);
}

/*
 * Run diagnostics in the background without claiming the busy lock
 * (so the user can still interact with checkboxes etc. while we
 * poll). Failure is silent -- this is best-effort. The status text
 * reflects the operation only briefly so it doesn't block ordinary
 * UI feedback.
 */
function autoRunDiagnostic(msg) {
	if (busy) {
		// User is doing something; defer until they're done. We'll
		// catch it next time refreshConfig completes (page bootstrap)
		// or next boot poll transition.
		return;
	}
	const prev = statusText.textContent;
	statusText.textContent = msg || t("自动诊断中...");
	refreshDiagnostics()
		.then(() => {
			// statusText is overwritten by refreshDiagnostics on
			// success ("诊断已生成"), leave it as is.
		})
		.catch(() => {
			statusText.textContent = prev;
		});
}

function describeBootState(snapshot, moduleLoaded) {
	const boot = snapshot.bootState;
	if (!boot || !boot.state) return null;

	const now = snapshot.nowEpoch || Math.floor(Date.now() / 1000);
	const remaining = boot.deadline ? Math.max(0, boot.deadline - now) : 0;
	const detailSuffix = boot.detail ? `（${boot.detail}）` : "";

	switch (boot.state) {
		case "init":
			return moduleLoaded ? null : {
				level: "warn",
				title: t("开机服务正在准备"),
				body: t("service.sh 已开始执行，正在加载配置。"),
			};
		case "waiting-targets":
			return {
				level: "warn",
				title: t("正在等待隐藏路径出现"),
				body: remaining > 0
					? t(`还需等待最多 {0} 秒，超时仍不存在的路径会被跳过。{1}`, [remaining, detailSuffix])
					: t(`等待已超时，模块可能已跳过加载。{0}`, [detailSuffix]),
			};
		case "waiting-packages":
			return {
				level: "warn",
				title: t("正在等待包名解析为 UID"),
				body: remaining > 0
					? t(`还需等待最多 {0} 秒，超时未解析到 UID 会跳过加载。{1}`, [remaining, detailSuffix])
					: t(`等待已超时，模块可能已跳过加载。{0}`, [detailSuffix]),
			};
		case "loaded":
			return null;
		case "already-loaded":
			return moduleLoaded ? null : {
				level: "warn",
				title: t("上次开机时模块已存在"),
				body: t("service.sh 检测到 pathmask 已被加载，跳过 insmod。"),
			};
		case "skipped-targets-missing":
			return {
				level: "warn",
				title: t("所有隐藏路径在等待结束时仍不存在"),
				body: t(`service.sh 跳过加载。可调大等待秒数或检查路径是否拼写正确。{0}`, [detailSuffix]),
			};
		case "skipped-no-uids": {
			const allowMode = (boot.detail || "").indexOf("allow mode") !== -1;
			return {
				level: "warn",
				title: allowMode ? t("allow 白名单未解析到任何 UID") : t("deny 模式下未解析到任何 UID"),
				body: t(`service.sh 跳过加载。检查包名是否拼写正确，或填写直接 UID。{0}`, [detailSuffix]),
			};
		}
		case "skipped-empty-targets":
			return {
				level: "bad",
				title: t("隐藏路径配置为空"),
				body: t(`service.sh 立即退出。{0}`, [detailSuffix]),
			};
		case "skipped-fail-guard":
			return {
				level: "bad",
				title: t("连续加载失败保护跳过加载"),
				body: t(`保存并热重载会重置保护并重试。{0}`, [detailSuffix]),
			};
		case "skipped-legacy-loaded":
			return {
				level: "warn",
				title: t("旧 nohello 模块占据内核"),
				body: t(`卸载旧模块后重启即可加载 PathMask。{0}`, [detailSuffix]),
			};
		case "failed-missing-ko":
			return {
				level: "bad",
				title: t("pathmask.ko 文件丢失"),
				body: t(`重新安装模块包。{0}`, [detailSuffix]),
			};
		case "failed-insmod":
			return {
				level: "bad",
				title: t("insmod 失败"),
				body: t(`查看内核日志找 vermagic / unknown symbol / module_layout 等原因。{0}`, [detailSuffix]),
			};
		case "paused":
			return {
				level: "warn",
				title: t("WebUI 已暂停隐藏"),
				body: t("热重载或重启后会恢复加载。"),
			};
		default:
			return null;
	}
}

async function refreshTargetProbe() {
	const paths = collectPaths();
	if (!paths.length) {
		lastSnapshot.targetProbe = "";
		return;
	}

	/*
	 * In global/allow scope, the module's own syscall hooks may intercept stat()
	 * for this WebUI shell. A direct `[ -e ]`
	 * probe would falsely report MISS for paths that the kernel actually
	 * resolved successfully, because that's exactly what global hiding
	 * does. Skip the stat probe and fall back to the kernel-side
	 * resolved_count parameter, which is set during insmod (before any
	 * hook is active) and is the ground truth.
	 *
	 * resolved_count tells us how many paths succeeded but not which
	 * ones, so we can only confidently mark them all OK when the count
	 * matches the configured list. When it's less, we surface a generic
	 * "kernel resolved N/M" so the UI no longer blames the wrong cause.
	 */
	const loaded = (lastSnapshot.moduleText || "").trim();
	const scope = normalizeScope(lastSnapshot.scopeText || "");
	if (loaded && (scope === "global" || scope === "allow")) {
		const resolved = Number.parseInt((lastSnapshot.sysResolvedCount || "").trim(), 10);
		if (Number.isFinite(resolved) && resolved >= 0) {
			lastSnapshot.targetProbe = paths.map((path) => (
				`HIDDEN ${path}`
			)).join("\n");
			lastSnapshot.targetProbeHidden = true;
			lastSnapshot.targetResolvedCount = resolved;
			return;
		}
	}
	lastSnapshot.targetProbeHidden = false;
	lastSnapshot.targetResolvedCount = -1;

	/*
	 * Build a probe per raw line. Three cases:
	 *   - literal `/foo/bar`       -> `[ -e /foo/bar ]`
	 *   - glob   `/dev/???/marker` -> emit a DYNAMIC marker; we don't
	 *                                expand from the WebUI because
	 *                                shell pathname expansion against
	 *                                /dev/<random> from an unrelated
	 *                                UID can interact poorly with
	 *                                selinux directory readability
	 *                                and produce confusing MISS
	 *                                verdicts. The kernel's
	 *                                resolved_count sysfs param is
	 *                                the source of truth.
	 *   - `dir:` prefix            -> strip prefix, then test the path
	 *                                that produces the parent the
	 *                                kernel will actually hide.
	 */
	const probes = paths.map((rawLine) => {
		const { path } = splitTargetLine(rawLine);
		const tag = shellQuote(rawLine);
		// Detect glob metas. We do *not* attempt to expand globs in
		// the WebUI: shell pathname expansion against /dev/<random>
		// from an unrelated UID can interact poorly with selinux
		// directory readability and produce confusing MISS verdicts.
		// The kernel knows what was resolved (resolved_count sysfs
		// param), so the UI surfaces glob lines verbatim with a
		// DYNAMIC marker and trusts the kernel side instead.
		if (path.indexOf("???") !== -1
		    || path.indexOf("*") !== -1
		    || path.indexOf("?") !== -1
		    || path.indexOf("[") !== -1) {
			return `echo DYNAMIC ${tag}`;
		}
		return `if [ -e ${shellQuote(path)} ]; then echo OK ${tag}; else echo MISS ${tag}; fi`;
	}).join("; ");
	lastSnapshot.targetProbe = await safeExec(probes);
}

async function validateConfig(options = {}) {
	const { throwOnError = false, requireModuleFile = false } = options;
	const errors = [];
	const warnings = [];
	const ok = [];
	const paths = collectPaths();
	const seenPaths = new Set();
	const scope = currentScope();
	const directUids = activeDirectUids();
	const allowSystemUids = scope === "allow" ? collectAllowSystemUids() : [];
	const packages = [...selectedPackages].sort();

	if (!paths.length && !$("#autoSceneDebugfsInput").checked) {
		errors.push(t("隐藏路径为空。"));
	}

	for (const rawLine of paths) {
		const { path, group } = splitTargetLine(rawLine);
		if (!path.startsWith("/")) {
			errors.push(t(`隐藏路径必须是绝对路径：{0}`, [rawLine]));
		}
		if (rawLine.includes(",")) {
			errors.push(t(`隐藏路径不能包含英文逗号：{0}`, [rawLine]));
		}
		if (group && /[:\s]/.test(group)) {
			errors.push(t(`组名不能包含冒号或空白：{0}`, [rawLine]));
		}
		if (seenPaths.has(rawLine)) {
			warnings.push(t(`重复路径会被重复传入内核：{0}`, [rawLine]));
		}
		seenPaths.add(rawLine);
	}

	for (const uid of directUids) {
		if (!/^\d+$/.test(uid)) {
			errors.push(t(`UID 只能填写数字：{0}`, [uid]));
		}
	}

	const waitRaw = $("#waitSecondsInput").value.trim();
	if (!waitRaw) {
		warnings.push(t(`等待秒数为空，将使用默认值 {0}。`, [DEFAULT_WAIT_SECONDS]));
	} else if (!/^\d+$/.test(waitRaw)) {
		errors.push(t(`等待秒数只能填写正整数：{0}`, [waitRaw]));
	} else {
		const waitNum = Number.parseInt(waitRaw, 10);
		if (waitNum <= 0) {
			errors.push(t("等待秒数必须大于 0。"));
		} else if (waitNum > 600) {
			warnings.push(t(`等待秒数较大（{0}s），开机加载会变慢。`, [waitNum]));
		}
	}

	if ((scope === "deny" || scope === "allow") && packages.length === 0 && directUids.length === 0 && allowSystemUids.length === 0) {
		const listName = scope === "allow" ? t("白名单") : t("黑名单");
		errors.push(t(`{0}模式下至少需要选择一个包名、填写一个 UID，或勾选系统 UID 放行。`, [listName]));
	}

	if (requireModuleFile && ((lastSnapshot.koInfo || "").includes("missing") ||
	    (lastSnapshot.koInfo || "").includes("No such file"))) {
		errors.push(t(`模块文件不存在：{0}`, [files.ko]));
	}

	await refreshTargetProbe();
	if (lastSnapshot.targetProbeHidden) {
		const resolved = Number.isFinite(lastSnapshot.targetResolvedCount) ? lastSnapshot.targetResolvedCount : -1;
		if (resolved >= 0 && resolved < paths.length) {
			warnings.push(t(`内核仅解析了 {0}/{1} 条路径（当前模式下 stat 会被自身拦截，跳过用户态校验）。`, [resolved, paths.length]));
		}
	} else {
		const probeLines = linesFromText(lastSnapshot.targetProbe || "");
		const missLines = probeLines.filter((line) => line.startsWith("MISS "));
		if (paths.length && missLines.length === paths.length) {
			warnings.push(t("当前所有隐藏路径都不存在，service.sh 会等待后跳过加载。"));
		} else if (missLines.length) {
			warnings.push(t(`{0} 条隐藏路径当前不存在，内核加载时会跳过这些路径。`, [missLines.length]));
		}
	}

	if ((scope === "deny" || scope === "allow") && packages.length) {
		// -F (fixed string) matters: package names always contain ".",
		// which a basic regex reads as "any character", so com.foo.bar
		// also matched comXfooXbar and reported OK for names that are
		// not installed -- defeating the point of the probe. -- stops a
		// leading dash from being parsed as an option.
		const packageProbe = await safeExec(`
for p in ${packages.map(shellQuote).join(" ")}; do
	if [ -f /data/system/packages.list ] && grep -qF -- "$p " /data/system/packages.list 2>/dev/null; then
		echo "OK $p"
	else
		echo "MISS $p"
	fi
done
true
`);
		const packageProbeLines = linesFromText(packageProbe);
		const missingPackages = packageProbeLines.filter((line) => line.startsWith("MISS "));
		if (missingPackages.length === packages.length && directUids.length === 0 && allowSystemUids.length === 0) {
			warnings.push(t("当前选择的包名可能都无法解析 UID，开机服务可能会跳过加载。"));
		} else if (missingPackages.length) {
			warnings.push(t(`{0} 个包名当前未在 packages.list 中找到。`, [missingPackages.length]));
		}
	}

	if (!errors.length && !warnings.length) {
		ok.push(t("配置校验通过。"));
	}

	lastValidation = { errors, warnings, ok };
	updateHealthList();

	if (errors.length) {
		statusText.textContent = t("配置校验未通过");
		showToast(t(`配置有 {0} 个错误`, [errors.length]));
		if (throwOnError) throw new Error(errors[0]);
		return false;
	}

	statusText.textContent = warnings.length ? t("配置校验有警告") : t("配置校验通过");
	showToast(warnings.length ? t(`校验完成：{0} 个警告`, [warnings.length]) : t("配置校验通过"));
	return true;
}

async function saveConfig() {
	await validateConfig({ throwOnError: true });
	const scope = currentScope();
	await writeLines(files.targets, collectPaths());
	await writeLines(files.hideDirents, [$("#hideDirentsInput").checked ? "1" : "0"]);
	await writeLines(files.enableSyscallHooks, [$("#enableSyscallHooksInput").checked ? "1" : "0"]);
	await writeLines(files.syscallHooks, [collectSyscallHooks().join(",")]);
	await writeLines(files.autoSceneDebugfs, [$("#autoSceneDebugfsInput").checked ? "1" : "0"]);
	await writeLines(files.scope, [scope]);
	syncActiveUidText();
	await writeLines(files.denyPackages, sortedPackageList("deny"));
	await writeLines(files.allowPackages, sortedPackageList("allow"));
	await writeLines(files.denyUids, linesFromText(uidTexts.deny || ""));
	await writeLines(files.allowUids, linesFromText(uidTexts.allow || ""));
	await writeLines(files.allowSystemUids, collectAllowSystemUids());
	await writeLines(files.waitSeconds, [String(currentWaitSeconds())]);
	await refreshConfig();
	statusText.textContent = t("已保存，重启后生效");
	showToast(t("已保存，重启后生效"));
}

/*
 * Resolved on demand rather than captured in a module-scope object.
 * A top-level `const` evaluates t() exactly once at load time, so the
 * labels kept coming back Chinese after the user switched the UI to
 * English -- refreshRenderedText() has no way to rebuild a const.
 */
function writePolicyLabel(value) {
	switch (value) {
		case "eacces": return t("伪装不存在");
		case "enoent": return t("旧版行为");
		case "passthrough":
		default: return t("跟随原厂");
	}
}

// write_op_policy is an insmod parameter fed by service.sh from the
// persistent conf, so switching it requires a full module reload. The
// reload command below is intentionally kept in sync with reloadModule.
async function applyWritePolicy() {
	const checked = document.querySelector('input[name="writePolicy"]:checked');
	const value = checked ? checked.value : "passthrough";
	await writeLines(files.writeOpPolicy, [value]);
	statusText.textContent = t("正在应用写入伪装策略...");
	const output = await execShell(
		`if grep -q '^1' ${shellQuote(files.procguardConf)} 2>/dev/null && grep -q '^${PROCGUARD_MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${PROCGUARD_MODULE_NAME} 2>/dev/null || true; fi; rm -f ${shellQuote(files.sceneDebugfsWatchStop)} ${shellQuote(files.failCount)} ${shellQuote(files.failReason)} 2>/dev/null || true; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME} || exit 20; fi; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then echo 'pathmask is still loaded after rmmod' >&2; exit 21; fi; PATHMASK_RESET_FAIL_GUARD=1 PATHMASK_IGNORE_FAIL_GUARD=1 PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=5 sh ${shellQuote(files.service)}; dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
	);
	setLogContent("kernel", output);
	await refreshDiagnostics();
	showToast(t(`写入伪装已切换为「{0}」`, [writePolicyLabel(value)]));
}

async function reloadModule() {
	await validateConfig({ throwOnError: true, requireModuleFile: true });
	const scope = currentScope();
	await writeLines(files.targets, collectPaths());
	await writeLines(files.hideDirents, [$("#hideDirentsInput").checked ? "1" : "0"]);
	await writeLines(files.enableSyscallHooks, [$("#enableSyscallHooksInput").checked ? "1" : "0"]);
	await writeLines(files.syscallHooks, [collectSyscallHooks().join(",")]);
	await writeLines(files.autoSceneDebugfs, [$("#autoSceneDebugfsInput").checked ? "1" : "0"]);
	await writeLines(files.scope, [scope]);
	syncActiveUidText();
	await writeLines(files.denyPackages, sortedPackageList("deny"));
	await writeLines(files.allowPackages, sortedPackageList("allow"));
	await writeLines(files.denyUids, linesFromText(uidTexts.deny || ""));
	await writeLines(files.allowUids, linesFromText(uidTexts.allow || ""));
	await writeLines(files.allowSystemUids, collectAllowSystemUids());
	await writeLines(files.waitSeconds, [String(currentWaitSeconds())]);
	statusText.textContent = t("正在热重载...");
	const output = await execShell(
		`if grep -q '^1' ${shellQuote(files.procguardConf)} 2>/dev/null && grep -q '^${PROCGUARD_MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${PROCGUARD_MODULE_NAME} 2>/dev/null || true; fi; rm -f ${shellQuote(files.sceneDebugfsWatchStop)} ${shellQuote(files.failCount)} ${shellQuote(files.failReason)} 2>/dev/null || true; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME} || exit 20; fi; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then echo 'pathmask is still loaded after rmmod' >&2; exit 21; fi; PATHMASK_RESET_FAIL_GUARD=1 PATHMASK_IGNORE_FAIL_GUARD=1 PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=5 sh ${shellQuote(files.service)}; dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
	);
	setLogContent("kernel", output);
	await refreshDiagnostics();
	const sceneState = lastSnapshot.sceneDebugfsState || {};
	if ($("#autoSceneDebugfsInput").checked && sceneState.status === "no-package") {
		showToast(t("热重载完成；未安装 Scene，已跳过自动识别"));
	} else if ($("#autoSceneDebugfsInput").checked && sceneState.status === "late-watching") {
		showToast(t("热重载完成，后台继续等待 Scene 启动"));
	} else if ($("#autoSceneDebugfsInput").checked && sceneState.status !== "found" && sceneState.status !== "late-found") {
		showToast(t("热重载完成，但当前未识别到 Scene debugfs"));
	} else {
		showToast(t("热重载完成"));
	}
}

async function pauseHiding() {
	const output = await execShell(
		`touch ${shellQuote(files.sceneDebugfsWatchStop)} 2>/dev/null || true; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME}; log -p i -t pathmask 'hidden paths paused from WebUI'; printf 'state=paused\\nupdated=%s\\ndetail=paused via WebUI\\n' "$(date +%s 2>/dev/null || echo 0)" > ${shellQuote(files.bootState)} 2>/dev/null || true; echo 'pathmask unloaded'; else printf 'state=paused\\nupdated=%s\\ndetail=paused via WebUI\\n' "$(date +%s 2>/dev/null || echo 0)" > ${shellQuote(files.bootState)} 2>/dev/null || true; echo 'pathmask is not loaded'; fi; dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
	);
	setLogContent("kernel", output);
	await refreshDiagnostics();
	statusText.textContent = t("隐藏已暂停，热重载可恢复");
	showToast(t("隐藏已暂停"));
}

async function restoreDefaults() {
	await writeLines(files.targets, DEFAULT_TARGET_PATHS);
	await writeLines(files.hideDirents, ["1"]);
	await writeLines(files.enableSyscallHooks, ["1"]);
	await writeLines(files.syscallHooks, [DEFAULT_SYSCALL_HOOKS.join(",")]);
	await writeLines(files.autoSceneDebugfs, [DEFAULT_AUTO_SCENE_DEBUGFS ? "1" : "0"]);
	await writeLines(files.scope, ["deny"]);
	await writeLines(files.denyPackages, DEFAULT_DENY_PACKAGES);
	await writeLines(files.allowPackages, []);
	await writeLines(files.denyUids, []);
	await writeLines(files.allowUids, []);
	await writeLines(files.allowSystemUids, DEFAULT_ALLOW_SYSTEM_UIDS);
	await writeLines(files.waitSeconds, [String(DEFAULT_WAIT_SECONDS)]);
	await refreshConfig();
	showToast(t("已恢复默认配置，重启后生效"));
}

function currentWaitSeconds() {
	const value = Number.parseInt($("#waitSecondsInput").value, 10);
	if (Number.isFinite(value) && value > 0) return value;
	return DEFAULT_WAIT_SECONDS;
}

async function refreshDiagnostics() {
	await refreshConfig();

	const statusLog = await safeExec(`
echo '--- basic ---'
date 2>/dev/null || true
uname -a 2>/dev/null || true
getprop ro.build.version.release 2>/dev/null || true
getprop ro.product.manufacturer 2>/dev/null || true
getprop ro.product.device 2>/dev/null || true
echo '--- modules ---'
grep -E '^(pathmask|procguard|nohello) ' /proc/modules 2>/dev/null || true
echo '--- module files ---'
ls -l ${shellQuote(MODDIR)} 2>/dev/null || true
ls -l ${shellQuote(LEGACY_MODDIR)} 2>/dev/null || true
echo '--- sysfs parameters ---'
for f in /sys/module/pathmask/parameters/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done
echo '--- procguard parameters ---'
for f in /sys/module/procguard/parameters/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done
echo '--- load failure guard ---'
[ -f ${shellQuote(files.failCount)} ] && echo "load_fail_count=$(cat ${shellQuote(files.failCount)} 2>/dev/null)" || echo "load_fail_count=0"
[ -f ${shellQuote(files.failReason)} ] && echo "load_fail_reason=$(cat ${shellQuote(files.failReason)} 2>/dev/null)"
true
`);

	const configLog = await safeExec(`
echo '--- persistent config ---'
for f in ${shellQuote(CONFIGDIR)}/*.conf; do [ -f "$f" ] && echo "### $f" && cat "$f" && echo; done
echo '--- boot state ---'
# boot_state lives outside the *.conf glob above and is the single
# most useful signal when the module is "just not loaded": it tells
# us which exit branch service.sh took. Missing file means service.sh
# never ran at all (KSU service.d scheduling issue, not a PathMask bug).
if [ -f ${shellQuote(files.bootState)} ]; then
  cat ${shellQuote(files.bootState)} 2>/dev/null
else
  echo "(no boot_state file -- service.sh did not run, or persist dir is unwritable)"
fi
echo '--- Scene debugfs auto-discovery ---'
if [ -f ${shellQuote(files.sceneDebugfsState)} ]; then
  cat ${shellQuote(files.sceneDebugfsState)} 2>/dev/null
else
  echo "(no scene_debugfs_state)"
fi
if [ -s ${shellQuote(files.sceneDebugfsPaths)} ]; then
  echo 'runtime paths:'
  cat ${shellQuote(files.sceneDebugfsPaths)} 2>/dev/null
fi
echo '--- legacy config ---'
for f in ${shellQuote(LEGACY_CONFIGDIR)}/*.conf; do [ -f "$f" ] && echo "### $f" && cat "$f" && echo; done
echo '--- target existence ---'
if [ -f ${shellQuote(files.targets)} ]; then
  scope=$(cat ${shellQuote(files.scope)} 2>/dev/null | head -n1 | tr -d ' \\t\\r\\n')
  loaded=$(grep -c '^${MODULE_NAME} ' /proc/modules 2>/dev/null || echo 0)
  if { [ "$scope" = "global" ] || [ "$scope" = "allow" ]; } && [ "$loaded" -gt 0 ]; then
    resolved=$(cat /sys/module/${MODULE_NAME}/parameters/resolved_count 2>/dev/null || echo ?)
    echo "(scope=$scope, kernel resolved $resolved target(s); skipping user-space stat probe to avoid self-hide)"
  else
    # Probe each line: strip optional dir: prefix, translate ??? to
    # shell *, then either glob-expand (and report HIT/EMPTY) or
    # plain test -e for literals. Without this, lines like
    # /dev/???/scene_mode_category are stat()ed verbatim and always
    # come back as MISS, falsely alarming the user even when the
    # kernel has the resolved hash dir hidden correctly.
    while IFS= read -r p || [ -n "$p" ]; do
      [ -z "$p" ] && continue
      case "$p" in \\#*) continue;; esac
      raw="$p"
      # Strip optional any:<group>: prefix (purely for the wait
      # logic; the path under it is checked the same way).
      case "$p" in
        any:*:*)
          rest=\${p#any:}
          p=\${rest#*:}
          ;;
      esac
      case "$p" in dir:*) p=\${p#dir:};; esac
      pat=$(printf '%s' "$p" | sed 's/[?][?][?]/*/g')
      case "$pat" in
        *'*'*|*'?'*|*'['*)
          # Glob form. Use a child shell to enable expansion;
          # nullglob isn't available in toybox sh so we test the
          # first match directly.
          first=$(/system/bin/sh -c "for m in $pat; do [ -e \\"\\$m\\" ] && echo \\"\\$m\\" && break; done" 2>/dev/null)
          if [ -n "$first" ]; then
            echo "HIT $raw -> $first"
          else
            echo "EMPTY $raw (glob currently has no matches)"
          fi
          ;;
        *)
          if [ -e "$pat" ]; then
            echo "OK $raw"
          else
            echo "MISS $raw"
          fi
          ;;
      esac
    done < ${shellQuote(files.targets)}
  fi
fi
true
`);

	// logcat is a separate trip because on stricter ROMs it returns
	// `Operation not permitted` -- we want to surface that distinctly
	// from "no pathmask lines logged" instead of swallowing it.
	const scriptProbe = await probeExec(`logcat -d -s pathmask nohello 2>&1 | tail -n 300`);
	let scriptLog = "";
	let scriptLogReason = "";
	if (scriptProbe.ok) {
		scriptLog = scriptProbe.stdout || "";
	} else {
		scriptLog = "";
		scriptLogReason = t("logcat 不可读（{0}）", [
			scriptProbe.stderr || scriptProbe.error || `errno=${scriptProbe.errno}`,
		]);
	}

	const moduleProp = (firstLine(await safeExec(`grep '^version=' ${shellQuote(MODDIR + "/module.prop")} 2>/dev/null | head -n1`)) || "").replace(/^version=/, "");

	// Snapshot has the latest config-driven facts; gather kernel /
	// module / dmesg signals next, then run the verdict engine and
	// build the layered report.
	lastSnapshot.statusLog = statusLog;
	lastSnapshot.configLog = configLog;
	lastSnapshot.scriptLog = scriptLog;
	lastSnapshot.scriptLogReason = scriptLogReason;
	lastSnapshot.moduleProp = moduleProp;

	const facts = await gatherDiagnosticFacts(lastSnapshot);
	const verdict = computeVerdict(facts);

	lastSnapshot.facts = facts;
	lastSnapshot.verdict = verdict;
	lastSnapshot.kernelLog = facts.dmesgState.available
		? (facts.dmesgRaw || t("(dmesg 中没有 pathmask 相关行)"))
		: t(`(dmesg 不可读：{0})`, [facts.dmesgState.reason]);

	setLogContent("status", statusLog);
	setLogContent("config", configLog);
	setLogContent("script", scriptLog || t("({0})", [scriptLogReason || t("无 pathmask 相关 logcat")]));
	setLogContent("kernel", lastSnapshot.kernelLog);
	renderVerdictPanel(lastSnapshot);
	lastReport = buildReport(lastSnapshot);
	$("#reportOutput").value = lastReport;
	statusText.textContent = t("诊断已生成");
	showToast(t("诊断报告已生成"));
	updateHealthList();
	// Save snapshot to /data/adb/pathmask/diag-history/. Best-effort:
	// any failure here (FS read-only, dir not creatable) is logged
	// but doesn't break the diagnostic flow itself.
	saveDiagnosticHistory(lastReport).catch(() => {});
}

const DIAG_HISTORY_DIR = `${CONFIGDIR}/diag-history`;
const DIAG_HISTORY_KEEP = 5;

async function saveDiagnosticHistory(report) {
	if (!report) return;
	const epoch = Math.floor(Date.now() / 1000);
	// One file per snapshot. Keep at most DIAG_HISTORY_KEEP, trim
	// older ones in the same shell to keep this single round trip.
	const path = `${DIAG_HISTORY_DIR}/diag-${epoch}.txt`;
	// Heredoc with a quoted marker keeps the report content literal
	// (no $/`/\ expansion). Marker includes a random-ish suffix so a
	// report that quotes itself can't accidentally close the heredoc.
	const marker = `PMHIST_EOF_${epoch}_${Math.random().toString(36).slice(2, 8)}`;
	const cmd = `
mkdir -p ${shellQuote(DIAG_HISTORY_DIR)} 2>/dev/null || true
chmod 0700 ${shellQuote(DIAG_HISTORY_DIR)} 2>/dev/null || true
cat > ${shellQuote(path)} <<'${marker}'
${report}
${marker}
chmod 0600 ${shellQuote(path)} 2>/dev/null || true
# Trim older snapshots: keep the newest ${DIAG_HISTORY_KEEP} only.
ls -1t ${shellQuote(DIAG_HISTORY_DIR)}/diag-*.txt 2>/dev/null | awk -v keep=${DIAG_HISTORY_KEEP} 'NR>keep' | xargs -r rm -f 2>/dev/null || true
true
`;
	await safeExec(cmd);
}

async function listDiagnosticHistory() {
	const out = await safeExec(`ls -1t ${shellQuote(DIAG_HISTORY_DIR)}/diag-*.txt 2>/dev/null || true`);
	return (out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function readDiagnosticHistory(path) {
	return await safeExec(`[ -f ${shellQuote(path)} ] && cat ${shellQuote(path)} || echo "(not found)"`);
}

let historySelectedPath = "";

async function openHistoryModal() {
	const list = await listDiagnosticHistory();
	const ul = $("#historyList");
	const view = $("#historyView");
	if (!ul || !view) return;
	ul.textContent = "";
	view.value = "";
	historySelectedPath = "";

	if (list.length === 0) {
		const li = document.createElement("li");
		li.className = "healthItem level-info";
		li.textContent = t("（暂无历史诊断。每次点「生成诊断」会自动保存一份。）");
		ul.append(li);
		openModal("historyModal");
		return;
	}

	for (const path of list) {
		// Path looks like .../diag-1779623417.txt; pull the epoch out
		// and render as local time so users can compare runs at a
		// glance without doing date math.
		const m = path.match(/diag-(\d+)\.txt$/);
		const epoch = m ? Number.parseInt(m[1], 10) : 0;
		const when = epoch ? new Date(epoch * 1000).toLocaleString() : path;
		const li = document.createElement("li");
		li.className = "healthItem level-info historyItem";
		li.tabIndex = 0;
		li.textContent = when;
		li.dataset.path = path;
		li.addEventListener("click", () => selectHistory(path, li));
		li.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				selectHistory(path, li);
			}
		});
		ul.append(li);
	}
	openModal("historyModal");
}

async function selectHistory(path, liElem) {
	const all = $("#historyList").querySelectorAll(".historyItem");
	for (const node of all) node.classList.remove("active");
	if (liElem) liElem.classList.add("active");
	historySelectedPath = path;
	const text = await readDiagnosticHistory(path);
	$("#historyView").value = text || t("(空)");
}

function switchTab(tab) {
	for (const button of $$(".tab")) {
		const active = button.dataset.tab === tab;
		button.classList.toggle("active", active);
		/*
		 * Roving tabindex per the ARIA tabs pattern: only the selected
		 * tab is in the tab sequence, and arrow keys move between them
		 * (wired below). Without aria-selected the five buttons were
		 * announced identically, with nothing to say which page was
		 * actually showing.
		 */
		button.setAttribute("aria-selected", String(active));
		button.tabIndex = active ? 0 : -1;
	}
	for (const panel of $$(".tabPanel")) {
		panel.classList.toggle("active", panel.id === `${tab}Panel`);
	}
}

function switchLog(log) {
	activeLog = log;
	activeLogPage = 0;
	for (const button of $$(".logTab")) {
		const active = button.dataset.log === log;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
	}
	renderLogPage();
}

function openModal(id) {
	const modal = document.getElementById(id);
	if (!modal) return;
	modal.hidden = false;
	// Defer the focus call so the dialog has actually rendered
	// before we move focus into it; avoids a flash where the
	// previously focused element keeps its outline.
	setTimeout(() => {
		const closeBtn = modal.querySelector("[data-modal-close]");
		if (closeBtn) closeBtn.focus();
	}, 0);
}

function closeModal(id) {
	const modal = document.getElementById(id);
	if (!modal) return;
	modal.hidden = true;
	// Dismissing the confirm dialog by backdrop click or Escape is a "no".
	if (id === "confirmModal") settleConfirm(false);
}

/*
 * In-page confirmation. window.confirm() is not usable here: a WebView
 * whose host does not implement onJsConfirm returns false silently, so a
 * destructive action would present as a dead button instead of asking.
 * Resolves true only for 确定; every dismissal path resolves false. If
 * the dialog markup is somehow missing we fail closed rather than
 * proceeding with a destructive action unconfirmed.
 */
let confirmResolver = null;

function confirmAction(message) {
	const modal = $("#confirmModal");
	const body = $("#confirmBody");
	if (!modal || !body) return Promise.resolve(false);
	return new Promise((resolve) => {
		body.textContent = message;
		confirmResolver = resolve;
		openModal("confirmModal");
	});
}

function settleConfirm(result) {
	const resolve = confirmResolver;
	confirmResolver = null;
	const modal = $("#confirmModal");
	if (modal) modal.hidden = true;
	if (resolve) resolve(result);
}

document.addEventListener("click", (event) => {
	const trigger = event.target.closest("[data-modal-close]");
	if (!trigger) return;
	const id = trigger.getAttribute("data-modal-close");
	if (id) closeModal(id);
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	for (const modal of $$(".modal")) {
		if (!modal.hidden) closeModal(modal.id);
	}
});

$("#addPathBtn").addEventListener("click", () => addPathRow());
$("#pathHelpBtn").addEventListener("click", () => openModal("pathHelpModal"));
$("#donateBtn").addEventListener("click", () => openModal("donateModal"));
$("#historyBtn").addEventListener("click", () => runAction(t("正在加载历史诊断..."), openHistoryModal).catch(() => {}));
$("#historyCopyBtn").addEventListener("click", () => copyText($("#historyView").value).catch((error) => showToast(error.message)));
$("#loadAppsBtn").addEventListener("click", () => runAction(t("正在加载应用..."), loadApps).catch(() => {}));
$("#refreshBtn").addEventListener("click", () => runAction(t("正在刷新..."), refreshConfig).catch(() => {}));

// Live-update the per-syscall sub-panel disabled state when the master
// toggle is flipped, so it visibly tracks the dependency without waiting
// for the next refresh.
$("#enableSyscallHooksInput").addEventListener("change", updateSyscallHooksDisabledState);
$("#procguardEnableInput").addEventListener("change", () => {
	const enable = $("#procguardEnableInput").checked;
	runAction(enable ? t("正在启用隔离防护...") : t("正在停用隔离防护..."), () => setProcguardEnabled(enable)).catch(() => refreshConfig());
});
for (const radio of $$('input[name="writePolicy"]')) {
	radio.addEventListener("change", () => runAction(t("正在应用写入伪装策略..."), applyWritePolicy).catch(() => refreshConfig()));
}
$("#autoSceneDebugfsInput").addEventListener("change", () => {
	const enabled = $("#autoSceneDebugfsInput").checked;
	const node = $("#autoSceneDebugfsStatus");
	node.textContent = enabled ? t("保存并热重载或重启后生效") : "";
	node.hidden = !enabled;
	updateHealthList();
});
for (const cb of document.querySelectorAll('#allowSystemUidsDetails input[data-allow-system-uid]')) {
	cb.addEventListener("change", updateHealthList);
}
$("#confirmOkBtn").addEventListener("click", () => settleConfirm(true));
$("#confirmCancelBtn").addEventListener("click", () => settleConfirm(false));

// The 系统应用 flag is only read inside loadApps(), so without this the
// checkbox appeared to do nothing until 加载 was pressed again.
$("#showSystemInput").addEventListener("change", () => {
	runAction(t("正在加载应用..."), loadApps).catch(() => {});
});

$("#searchInput").addEventListener("input", renderApps);
$("#saveBtn").addEventListener("click", () => runAction(t("正在保存..."), saveConfig).catch(() => {}));
$("#pauseBtn").addEventListener("click", () => runAction(t("正在暂停隐藏..."), pauseHiding).catch(() => {}));
$("#reloadBtn").addEventListener("click", () => runAction(t("正在热重载..."), reloadModule).catch(() => {}));
$("#runDiagnosticBtn").addEventListener("click", () => runAction(t("正在生成诊断..."), refreshDiagnostics).catch(() => {}));
$("#validateConfigBtn").addEventListener("click", () => runAction(t("正在校验配置..."), () => validateConfig()).catch(() => {}));
$("#refreshLogsBtn").addEventListener("click", () => runAction(t("正在刷新日志..."), refreshDiagnostics).catch(() => {}));
$("#copyReportBtn").addEventListener("click", () => copyText(lastReport || buildReport()).catch((error) => showToast(error.message)));
$("#copyReportBtn2").addEventListener("click", () => copyText($("#reportOutput").value).catch((error) => showToast(error.message)));
$("#resetDefaultsBtn").addEventListener("click", () => {
	/*
	 * Confirm before running: restoreDefaults() overwrites every *.conf --
	 * including blanking allow_packages / deny_uids / allow_uids -- and the
	 * refreshConfig() it ends with also discards any edits still unsaved in
	 * the form. It sits one tap away in a "快速操作" grid next to 复制诊断
	 * 报告 and there is no undo. Confirmed outside runAction so the busy
	 * lock is not held while the prompt is on screen.
	 */
	confirmAction(t("恢复默认配置会覆盖所有 *.conf（清空白名单包名和直接 UID），并丢弃页面上未保存的修改。确定继续？"))
		.then((proceed) => {
			if (!proceed) {
				showToast(t("已取消，配置未改动"));
				return undefined;
			}
			return runAction(t("正在恢复默认配置..."), restoreDefaults).catch(() => {});
		});
});
$("#prevLogBtn").addEventListener("click", () => {
	activeLogPage -= 1;
	renderLogPage();
});
$("#nextLogBtn").addEventListener("click", () => {
	activeLogPage += 1;
	renderLogPage();
});

const tabButtons = $$(".tab");
for (const button of tabButtons) {
	button.addEventListener("click", () => switchTab(button.dataset.tab));
	button.addEventListener("keydown", (event) => {
		// Arrow-key navigation for the ARIA tabs pattern; the roving
		// tabindex maintained by switchTab() keeps exactly one tab in
		// the tab sequence.
		const step = event.key === "ArrowRight" ? 1
			: event.key === "ArrowLeft" ? -1
				: 0;
		if (!step) return;
		event.preventDefault();
		const index = tabButtons.indexOf(button);
		const next = tabButtons[(index + step + tabButtons.length) % tabButtons.length];
		switchTab(next.dataset.tab);
		next.focus();
	});
}

for (const button of $$(".logTab")) {
	button.addEventListener("click", () => switchLog(button.dataset.log));
}

for (const radio of document.querySelectorAll('input[name="scope"]')) {
	radio.addEventListener("change", () => {
		if (!radio.checked) return;
		setActiveScopeList(radio.value);
		updateScopeCopy(radio.value);
		renderApps();
		updateHealthList();
		if ((radio.value === "deny" || radio.value === "allow") && apps.length === 0) {
			loadApps().catch(() => {});
		}
	});
}

$("#denyUidsInput").addEventListener("input", () => {
	syncActiveUidText();
	updateHealthList();
});
$("#waitSecondsInput").addEventListener("input", updateHealthList);

for (const button of $$(".langOption")) {
	button.addEventListener("click", () => setUiLang(button.dataset.lang));
}
applyStaticText();

/*
 * No try/catch around the bootstrap. runAction() is async, so it converts
 * a synchronous throw into a rejected promise and a surrounding try can
 * never observe it -- the catch that used to sit here was unreachable, and
 * the code that genuinely can throw synchronously (the $("#id")
 * .addEventListener bindings above, where a renamed or removed id makes $
 * return null) was outside it. Any synchronous failure in this file is
 * already reported by the window "error" trap installed at the very top,
 * which writes the message and location into #statusText; the .catch()
 * below covers the async path.
 */
runAction(t("正在读取配置..."), refreshConfig).then(() => {
	// Auto-run diagnostics on page load when service.sh has
	// already finished (loaded / skipped-* / failed-*). For
	// waiting states we let scheduleBootPolling pick up the
	// transition and trigger then. For paused / unknown we
	// still run -- the verdict will reflect the actual state.
	const state = (lastSnapshot.bootState && lastSnapshot.bootState.state) || "";
	if (state && !BOOT_WAITING_STATES.has(state)) {
		autoRunDiagnostic(t("自动诊断中（页面加载）..."));
	} else if (!state) {
		// No boot_state file at all -- service.sh likely never
		// ran. Still run a diagnostic so the verdict catches it.
		autoRunDiagnostic(t("自动诊断中（页面加载）..."));
	}
}).catch((error) => {
	setStatusError(t("读取失败"), error);
});
