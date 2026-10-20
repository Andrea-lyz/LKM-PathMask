/*
 * Interface language support.
 *
 * The Simplified Chinese text in the markup and in the literals below
 * doubles as the translation key: EN_TEXT maps each Chinese source
 * string to its English wording. A missing entry falls back to the
 * Chinese source, so an unfinished translation is never blank.
 *
 * Static nodes opt in with data-i18n / data-i18n-html and the attribute
 * variants data-i18n-title, data-i18n-aria-label, data-i18n-placeholder
 * and data-i18n-alt. The original Chinese is captured once, then every
 * language switch rewrites from the captured copy.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.i18n = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
	"use strict";

	const UI_LANG_KEY = "pathmask.uiLang";
	const UI_LANGS = ["zh", "en"];

const EN_TEXT = {
	// Top bar / navigation shell.
	"捐赠": "Donate",
	"刷新": "Refresh",
	"正在读取状态...": "Reading status...",
	"页面": "Pages",
	"界面语言": "Interface language",
	"中文界面": "Chinese interface",
	"防护": "Guard",
	"诊断": "Health",
	"日志": "Logs",
	"报告": "Report",
	"保存配置": "Save config",
	"暂停隐藏": "Pause hiding",
	"保存并热重载": "Save & reload",

	// Status summary cards.
	"模块状态": "Module",
	"隐藏路径": "Hidden paths",
	"作用 UID": "Target UIDs",
	"白名单 UID": "Allowlist UIDs",
	"黑名单 UID": "Denylist UIDs",
	"未知": "Unknown",
	"已加载": "Loaded",
	"未加载": "Not loaded",

	// Scope presets.
	"全局": "Global",
	"白名单": "Allowlist",
	"黑名单": "Denylist",

	// Path rows.
	"组": "Group",
	"删": "Del",

	// Mask tab.
	"英文界面": "English interface",
	"路径配置说明": "Path configuration help",
	"添加": "Add",
	"自动识别 Scene debugfs": "Auto-detect Scene debugfs",
	"路径": "Path",
	"父级": "Parent",
	"作用范围": "Scope",
	"从 ls 列表中抹掉": "Remove from ls output",
	"syscall 兜底": "syscall fallback",
	"选择具体 syscall（高级）": "Pick individual syscalls (advanced)",
	"不推荐": "not recommended",
	"access(path), F_OK 时序探测面": "access(path), F_OK timing surface",
	"open() 主路径": "open() main path",
	"open() 新接口": "open() new interface",
	"加载": "Load",
	"直接填写 UID": "Enter UIDs directly",
	"每行一个 UID": "One UID per line",

	// Status line, toasts and per-scope copy (rendered from JS).
	"正在读取配置...": "Reading configuration...",
	"正在刷新...": "Refreshing...",
	"正在保存...": "Saving...",
	"正在热重载...": "Reloading...",
	"模块已加载": "Module loaded",
	"模块未加载": "Module not loaded",
	"应用白名单": "App allowlist",
	"应用黑名单": "App denylist",
	"应用列表": "App list",
	"黑名单模式：勾选的应用会看不到隐藏路径。":
		"Denylist mode: checked apps cannot see the hidden paths.",

	// Bridge / boot failures (the WebUI still renders when these fire).
	"KernelSU WebUI API 不可用": "The KernelSU WebUI API is not available",
	"读取失败": "Failed to read the configuration",

	// Health list (Diagnostics tab).
	"{0} 条路径。": "{0} paths.",
	"模块被禁用": "Module disabled",

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
	"已复制": "Copied",
	"insmod 失败": "insmod failed",

	// Save / reload / pause flows.
	"已保存，重启后生效": "Saved; takes effect after a reboot",
	"跟随原厂": "OEM default",
	"伪装不存在": "Pretend it does not exist",
	"旧版行为": "Legacy behaviour",
	"热重载完成": "Hot reload done",
	"隐藏已暂停": "Hiding paused",

	// Inline fallbacks that live inside larger templates.
	"很久": "a long while",
	"(未解析)": "(unresolved)",
	"无 pathmask 相关 logcat": "no pathmask logcat lines",

	// Guard tab.
	"隔离防护": "Isolated-process guard",
	"正在读取状态…": "Reading status…",
	"写入行为伪装": "Write behaviour masking",

	// Diagnostics / logs / report tabs.
	"结论": "Verdict",
	"生成诊断": "Run diagnostics",
	"快速操作": "Quick actions",
	"校验配置": "Configuration check",
	"历史诊断": "Diagnostic history",
	"恢复默认配置": "Restore defaults",
	"状态": "Status",
	"配置": "Config",
	"内核": "Kernel",
	"脚本": "Script",
	"上一页": "Previous",
	"下一页": "Next",
	"诊断报告": "Diagnostic report",
	"复制": "Copy",

	// Modals.
	"支持 PathMask": "Support PathMask",
	"关闭": "Close",
	"如果 PathMask 对你有帮助，欢迎自愿捐赠支持后续维护。":
		"If PathMask is useful to you, a voluntary donation supports its continued maintenance.",
	"微信与支付宝收款二维码": "WeChat and Alipay donation QR code",
	"请使用微信或支付宝扫码。感谢支持！":
		"Scan it with WeChat or Alipay. Thank you!",
	"(没有日志)": "(no log)",
	"0 条路径": "0 paths",
	"OR 组": "OR group",
	"OR 组（可选）": "OR group (optional)",
	"Scene 自动识别": "Scene auto-detection",
	"UID 列表": "UID list",
	"boot_state：{0}。生成诊断查看失败原因。": "boot_state: {0}. Run diagnostics to see the failure reason.",
	"dmesg 不可读": "dmesg unavailable",
	"mkdir/Create 返回 EACCES，删除/rename 返回 ENOENT。": "mkdir/Create returns EACCES; unlink/rename returns ENOENT.",
	"procguard 已加载": "procguard loaded",
	"procguard 未加载": "procguard not loaded",
	"service.sh 可能没有被 KernelSU 执行，检查模块状态和开机日志。": "service.sh may not have been executed by KernelSU. Check the module state and boot logs.",
	"service.sh 没有执行，或模块加载失败。": "service.sh did not run, or the module failed to load.",
	"sysfs 运行参数和 conf 不一致：{0}。": "sysfs runtime parameters differ from the conf files: {0}.",
	"target_path.conf 为空，隐藏不会发生。": "target_path.conf is empty, so nothing will be hidden.",
	"{0} 个 OR 组": "{0} OR group(s)",
	"{0} 个 UID": "{0} UID(s)",
	"{0} 个应用": "{0} app(s)",
	"{0} 条父级": "{0} parent path(s)",
	"{0} 项待应用": "{0} pending change(s)",
	"{0} 项未保存": "{0} unsaved change(s)",
	"{0}/{1} 条路径命中。": "{0}/{1} path(s) resolved.",
	"不存在": "missing",
	"不拦截，由文件系统返回原厂错误码。适合一般场景。": "Do not intercept; let the filesystem return its original error. Suitable for most cases.",
	"丢弃": "Discard",
	"丢弃未保存的修改": "Discard unsaved changes",
	"中": "中文",
	"仅保存": "Save only",
	"仅保存配置": "Save configuration only",
	"仅保存，重启后生效。": "Saved only; takes effect after reboot.",
	"仅白名单模式生效：root、system、shell 不被隐藏。": "Allowlist mode only: root, system and shell are not hidden.",
	"以 / 开头，指向要隐藏的文件或目录。": "Starts with / and points to the file or directory to hide.",
	"低频选项集中在这里，改完统一应用。": "Low-frequency options live here; apply them together.",
	"作用对象": "Applies to",
	"作用应用": "Affected apps",
	"保存": "Save",
	"修正后才能应用": "Fix these before applying",
	"先添加一条路径，再保存并重载。": "Add a path first, then save and reload.",
	"全局模式不读取应用列表": "Global mode ignores the app list",
	"全局模式：所有应用都看不到隐藏路径。": "Global mode: every app cannot see the hidden paths.",
	"全局模式：所有应用都看不到隐藏路径。应用列表不参与判断。": "Global mode: every app cannot see the hidden paths. The app list is not used.",
	"全部": "All",
	"全部应用": "All apps",
	"内核日志有错误": "Kernel log shows errors",
	"内核日志正常": "Kernel log looks clean",
	"写操作一律返回 ENOENT，仅为兼容旧配置。": "All write operations return ENOENT; legacy compatibility only.",
	"决定哪些应用看不到隐藏路径。": "Decides which apps cannot see the hidden paths.",
	"删除路径": "Delete path",
	"刷新会丢弃未保存的修改": "Refresh will discard unsaved changes",
	"加载失败，生成诊断查看原因。": "Loading failed; run diagnostics to see why.",
	"勾选后隐藏匹配项的父目录（dir:）。": "Hide the parent directory of each match (dir:).",
	"勾选的应用会看不到隐藏路径。": "Selected apps cannot see the hidden paths.",
	"匹配任意一段路径名，不跨 /。例如 /dev/???/scene_mode_category。": "Matches any single path component, never across /. For example /dev/???/scene_mode_category.",
	"去处理": "Fix",
	"去配置": "Configure",
	"取消": "Cancel",
	"只有选中的应用看不到隐藏路径，其他应用正常访问。": "Only selected apps cannot see the hidden paths; other apps work normally.",
	"可能是应用被卸载或包名变化：{0}。": "The app may have been uninstalled or renamed: {0}.",
	"同名组内任一行存在即可，未分组的行仍需各自存在。": "Any line in the same group is enough; ungrouped lines must each exist.",
	"启用 procguard": "Enable procguard",
	"启用 syscall 兜底": "Enable syscall fallback",
	"在父目录的 ls 结果里隐藏这一行；不影响父目录本身是否存在。": "Hide this entry in the parent directory's ls output; the parent itself still exists.",
	"复制失败，请长按报告手动复制": "Copy failed; long-press the report to copy it manually.",
	"复制报告": "Copy report",
	"失败计数为 {0}；检查内核版本和 dmesg。": "Failure count is {0}; check the kernel version and dmesg.",
	"存在 disable 或 remove 标记，KernelSU 不会加载这个模块。": "A disable or remove flag exists; KernelSU will not load this module.",
	"已丢弃未保存的修改": "Unsaved changes discarded",
	"已关闭": "Off",
	"已刷新": "Refreshed",
	"已加入 {0} 条运行时路径。": "Added {0} runtime path(s).",
	"已加载 · {0} 条路径": "Loaded · {0} path(s)",
	"已启用，等待重载": "Enabled, waiting for reload",
	"已启用，运行中未生效": "Enabled, not active yet",
	"已在内核中运行。": "Running in the kernel.",
	"已填写 {0} 个 UID": "{0} UID(s) entered",
	"已尝试加载": "Load attempted",
	"已恢复默认配置": "Defaults restored",
	"已暂停": "Paused",
	"已暂停隐藏": "Hiding paused",
	"已添加 {0} 条路径": "Added {0} path(s)",
	"已添加 {0} 条，跳过 {1} 条无效路径": "Added {0}; skipped {1} invalid path(s)",
	"已生效": "Active",
	"已选 0 个应用": "0 apps selected",
	"已选 {0} 个入口": "{0} entry point(s) selected",
	"已选 {0} 个应用 · {1} 个 UID": "{0} app(s) · {1} UID(s) selected",
	"已选 {0} 个应用": "{0} app(s) selected",
	"已选": "Selected",
	"常用入口，不用来回找页签。": "Common actions without switching tabs.",
	"应用": "Apps",
	"应用修改": "Apply changes",
	"应用列表不参与": "App list is not used",
	"应用列表加载失败": "Failed to load the app list",
	"应用列表还没有加载": "The app list has not loaded yet",
	"应用并重载": "Apply and reload",
	"应用筛选": "Filter apps",
	"开启": "On",
	"开机流程失败": "Boot sequence failed",
	"开机流程完成": "Boot sequence complete",
	"开机流程已暂停": "Boot sequence paused",
	"开机流程未完成": "Boot sequence did not finish",
	"开机等待": "Boot wait",
	"开机等待中": "Waiting at boot",
	"开机等待还剩约 {0} 秒；超时后会跳过本次加载。": "About {0} seconds of boot wait remain; after timeout this load is skipped.",
	"当前改动还没有写入磁盘；应用并重载会立即覆盖运行配置。": "The current changes are not on disk yet; Apply and reload will replace the running configuration.",
	"当前草稿会恢复为上次保存的配置。": "The draft will be restored to the last saved configuration.",
	"当前隐藏": "Currently hidden",
	"待配置": "Needs setup",
	"快捷操作": "Quick actions",
	"恢复默认": "Restore defaults",
	"恢复默认失败": "Failed to restore defaults",
	"所有应用都看不到隐藏路径。应用列表不参与判断。": "Every app cannot see the hidden paths. The app list is not used.",
	"所有应用都看不到隐藏路径，无需逐个勾选。": "Every app cannot see the hidden paths; no per-app selection is needed.",
	"手动暂停": "Manually paused",
	"打开“应用”页签会自动加载。": "Open the Apps segment to load the list automatically.",
	"打开设置": "Open settings",
	"打开诊断查看详情。": "Open diagnostics for details.",
	"批量粘贴": "Bulk paste",
	"批量粘贴路径": "Bulk paste paths",
	"找不到 pathmask.ko，重新刷入模块。": "pathmask.ko is missing; flash the module again.",
	"报告已复制": "Report copied",
	"拦截 stat / access / open 等入口，绕开内联导致的 hook 漏触发。": "Intercept stat / access / open entry points to catch hooks that inlining skips.",
	"换个关键词，或切换筛选条件。": "Try another keyword or filter.",
	"提示": "Info",
	"搜索应用名或包名": "Search app name or package",
	"支持 ??? 通配；同名组内任一行命中即视为满足。": "Supports ??? wildcards; any matching line in the same group satisfies the group.",
	"支持 dir: 父级前缀和 any:<组>: 前缀；空行与 # 注释会被忽略。": "Supports the dir: parent prefix and any:<group>: prefix; blank lines and # comments are ignored.",
	"改动只保存在当前页面；应用并重载后才会写入磁盘并生效。": "Changes stay in this page until Apply and reload writes them to disk.",
	"放行系统 UID": "Allow system UIDs",
	"无法探测": "Cannot probe",
	"无法读取内核日志。": "Cannot read the kernel log.",
	"日志类型": "Log type",
	"旧模块仍在运行": "Legacy module still running",
	"暂停失败": "Pause failed",
	"最近一次诊断": "Latest diagnosis",
	"最近诊断": "Latest diagnosis",
	"有 UID 不属于已选应用": "Some UIDs do not belong to selected apps",
	"有应用未解析为 UID": "Some apps did not resolve to a UID",
	"有提醒": "Warning",
	"有改动": "Changed",
	"有未保存的修改": "Unsaved changes",
	"有问题": "Problem",
	"未匹配": "No match",
	"未启用": "Not enabled",
	"未直接填写 UID": "No UIDs entered",
	"未解析": "Unresolved",
	"未选择应用": "No apps selected",
	"查看": "View",
	"查看目标": "View targets",
	"检查 WebUI 权限": "Check WebUI permissions",
	"检查中": "Checking",
	"检测 Scene 的 debugfs 挂载点，并作为运行时路径加入。": "Detect Scene's debugfs mount point and add it as a runtime path.",
	"检测方对隐藏路径执行写操作时返回的错误码。": "The error code returned when a detector writes to a hidden path.",
	"概览": "Overview",
	"模块加载失败": "Module failed to load",
	"模块已加载，隐藏路径和运行参数已就绪。": "The module is loaded; hidden paths and runtime parameters are ready.",
	"模块已卸载，隐藏路径恢复可见。应用并重载可恢复。": "The module is unloaded and hidden paths are visible again. Apply and reload to restore.",
	"模块文件缺失": "Module file missing",
	"模块正在等待隐藏路径或包名解析完成。": "The module is waiting for hidden paths or package resolution.",
	"正在等待目标出现": "Waiting for targets to appear",
	"正在诊断...": "Diagnosing...",
	"正在读取模块、配置和内核状态...": "Reading module, configuration and kernel state...",
	"正在读取状态": "Reading status",
	"每行一条路径": "One path per line",
	"没有匹配的应用": "No matching apps",
	"没有发现模块加载或符号解析错误。": "No module-load or symbol-resolution errors found.",
	"没有可添加的路径": "No paths to add",
	"没有找到运行中的 pathmask 模块。": "No running pathmask module found.",
	"没有目标路径": "No target paths",
	"没有选择应用。": "No apps selected.",
	"没有额外建议。": "No further suggestions.",
	"添加路径": "Add path",
	"添加路径后，隐藏才会实际发生。": "Hiding starts only after a path is added.",
	"清除搜索": "Clear search",
	"点击“应用并重载”写入配置；只想留到下次重启可以点“仅保存”。": "Use Apply and reload to write the configuration; Save only keeps it for the next reboot.",
	"点击“重新诊断”后这里会出现可复制报告": "Run diagnostics to generate a copyable report",
	"点击“重新诊断”读取模块、配置和内核状态。": "Run diagnostics to read the module, configuration and kernel state.",
	"状态摘要": "Status summary",
	"用户": "User",
	"界面": "Interface",
	"白名单模式：选中的应用不受影响，其他应用看不到隐藏路径。": "Allowlist mode: selected apps are unaffected; other apps cannot see the hidden paths.",
	"白名单模式：选中的应用不受影响，其他应用默认看不到隐藏路径。": "Allowlist mode: selected apps are unaffected; other apps cannot see the hidden paths by default.",
	"目标": "Targets",
	"目标设置": "Target settings",
	"目标路径已解析": "Target paths resolved",
	"目标路径未全部解析": "Not all target paths resolved",
	"直接填写 UID（高级）": "Enter UIDs directly (advanced)",
	"确认": "Confirm",
	"确认操作": "Confirm action",
	"稍等，正在读取模块与配置。": "Please wait; reading the module and configuration.",
	"等待中": "Waiting",
	"等待秒数": "Wait seconds",
	"等待秒数必须在 1–600 之间": "Wait seconds must be between 1 and 600",
	"系统": "System",
	"绝对路径": "Absolute path",
	"绝对路径，支持 ??? 通配、父级隐藏和 OR 组。": "Absolute paths; supports ??? wildcards, parent hiding and OR groups.",
	"维护": "Maintenance",
	"编辑": "Edit",
	"编辑路径": "Edit path",
	"缺少 boot_state": "Missing boot_state",
	"自动换行": "Wrap lines",
	"至少保留一个 syscall 入口": "Keep at least one syscall entry point",
	"范围": "Scope",
	"让隔离进程无法遍历 /proc 发现模块挂载；应用更改后热重载生效。": "Prevent isolation processes from discovering module mounts via /proc; takes effect after reload.",
	"设置": "Settings",
	"诊断发现问题": "Diagnostics found a problem",
	"诊断失败": "Diagnosis failed",
	"诊断完成": "Diagnosis complete",
	"诊断完成，但发现问题": "Diagnosis complete, but problems were found",
	"诊断有提醒": "Diagnosis has warnings",
	"诊断视图": "Diagnostics view",
	"语言切换不会丢掉未保存的编辑。": "Switching language keeps unsaved edits.",
	"请在设置中暂停隐藏": "Pause hiding in Settings",
	"读取历史失败": "Failed to read history",
	"读取磁盘上的配置会覆盖当前草稿。继续吗？": "Reading the on-disk configuration will overwrite the current draft. Continue?",
	"读取配置失败": "Failed to read configuration",
	"路径、范围、应用列表和所有高级选项都会恢复为模块默认值。当前草稿会丢失。": "Paths, scope, app lists and all advanced options will return to module defaults. The current draft will be lost.",
	"路径出现和包名解析共用的总预算。": "Shared budget for path appearance and package resolution.",
	"路径已删除": "Path deleted",
	"路径已更新": "Path updated",
	"路径已添加": "Path added",
	"路径当前是否存在由页面探测；带 ??? 的路径匹配不到是正常现象。": "Path existence is probed by the page; a ??? path with no match is normal.",
	"运行中": "Running",
	"运行诊断": "Run diagnostics",
	"还没有历史诊断。运行一次诊断后会自动保存。": "No diagnostic history yet. A diagnosis is saved automatically after it runs.",
	"还没有发现可用的 debugfs 挂载点。": "No usable debugfs mount point found yet.",
	"还没有可复制的报告": "No report to copy yet",
	"还没有生成诊断": "No diagnosis yet",
	"还没有生成诊断。": "No diagnosis yet.",
	"还没有诊断结果": "No diagnosis results yet",
	"还没有运行诊断。": "Diagnostics have not run yet.",
	"还没有选择应用或 UID": "No apps or UIDs selected",
	"还没有配置": "Not configured",
	"还没有配置隐藏路径。": "No hidden paths configured.",
	"还没有隐藏路径": "No hidden paths yet",
	"这些包名当前找不到 UID：{0}。": "These packages currently have no UID: {0}.",
	"这些操作会影响正在运行的模块，执行前会再次确认。": "These actions affect the running module and ask for confirmation first.",
	"这些路径对作用范围内的应用不可见。": "These paths are invisible to apps in scope.",
	"这会立刻卸载 pathmask 内核模块，隐藏路径会恢复可见，直到你重新应用或重启。继续吗？": "This unloads the pathmask kernel module immediately and makes hidden paths visible until you apply again or reboot. Continue?",
	"连续加载失败": "Repeated load failures",
	"选中的应用不受影响，其他应用默认看不到隐藏路径。": "Selected apps are unaffected; other apps cannot see the hidden paths by default.",
	"选择应用": "Select apps",
	"通过": "Pass",
	"配置 {0} 条，运行中解析到 {1} 条。通配路径可能本来就没有匹配。": "{0} configured, {1} resolved at runtime. A wildcard path may simply have no match.",
	"配置会写入磁盘，但当前运行状态不会改变；需要重启或稍后点“应用并重载”才生效。": "The configuration will be written to disk, but the running state will not change until a reboot or Apply and reload.",
	"配置已启用，但模块没有出现在 /proc/modules。": "The configuration is enabled, but the module is not in /proc/modules.",
	"配置有问题": "Configuration problem",
	"配置未热重载": "Configuration not hot-reloaded",
	"重新加载": "Reload",
	"重新诊断": "Run diagnostics again",
	"隐藏匹配项的父目录，适合随机父目录场景。": "Hide the parent directory of each match; useful for random parent directories.",
	"隐藏已生效": "Hiding is active",
	"隐藏路径当前不会生效。": "Hidden paths are not active right now.",
	"隔离进程保护正在运行。": "Isolation process protection is running.",
	"需处理": "Needs attention",
	"黑名单模式：只有选中的应用看不到隐藏路径。": "Denylist mode: only selected apps cannot see the hidden paths.",
	"默认 60 秒。包名解析慢的设备可以调大；此选项仅保存，重启后生效。": "Default 60 seconds. Increase it on devices with slow package resolution; this option is saved and takes effect after reboot.",
	"默认只挂 6 个，不推荐开启 faccessat。": "Six hooks are enabled by default; enabling faccessat is not recommended.",
	"添加第一条路径后，应用并重载即可生效。": "Add the first path, then apply and reload.",
	"路径不能为空": "Path cannot be empty",
	"路径必须是绝对路径：{0}": "Path must be absolute: {0}",
	"路径不能包含空白字符：{0}": "Path cannot contain whitespace: {0}",
	"OR 组名不能包含空格或冒号：{0}": "OR group cannot contain spaces or colons: {0}",
	"路径重复：{0}": "Duplicate path: {0}",
	"UID 必须是数字：{0}": "UID must be numeric: {0}",
	"系统 UID 必须是数字：{0}": "System UID must be numeric: {0}",
	"还没有隐藏路径，模块加载后不会隐藏任何文件。": "No hidden paths configured; the module will not hide anything after loading.",
	"白名单模式没有选择任何应用或 UID，所有应用都会被隐藏。": "Allowlist mode has no apps or UIDs; every app will be hidden.",
	"黑名单模式没有选择任何应用或 UID，隐藏不会作用于任何应用。": "Denylist mode has no apps or UIDs; hiding will not affect any app.",
	"全局模式会忽略应用列表；已选应用会保留但不参与判断。": "Global mode ignores the app list; selected apps are kept but not used.",
	"运行中仍启用": "Still enabled at runtime",
	"应用并重载后开始识别。": "Apply and reload to start detecting it.",
	"应用并重载后关闭；当前仍会加入 {0} 条路径。": "Apply and reload to turn it off; {0} path(s) are still added right now.",
	"应用并重载后关闭。": "Apply and reload to turn it off.",
};

	const textSource = new Map();
	const htmlSource = new Map();
	const attrSource = new Map();
	const leadSource = new Map();

	function safeStorage() {
		try {
			return root && root.localStorage ? root.localStorage : null;
		} catch (error) {
			return null;
		}
	}

	function detectUiLang(storage = safeStorage(), navigatorLike) {
		if (navigatorLike === undefined) {
			navigatorLike = storage && storage.languages ? storage : (root && root.navigator);
		}
		try {
			const saved = storage ? storage.getItem(UI_LANG_KEY) : null;
			if (UI_LANGS.includes(saved)) return saved;
		} catch (error) {
			// Storage can be unavailable in a locked-down WebView.
		}
		const tags = navigatorLike && navigatorLike.languages && navigatorLike.languages.length
			? navigatorLike.languages
			: [navigatorLike && navigatorLike.language ? navigatorLike.language : ""];
		for (const tag of tags) {
			if (/^zh/i.test(tag)) return "zh";
			if (/^en/i.test(tag)) return "en";
		}
		return "zh";
	}

	let uiLang = detectUiLang();

	function translate(lang, source, params) {
		if (source === undefined || source === null) return source;
		let text = lang === "en" ? (EN_TEXT[source] ?? source) : source;
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

	function t(source, params) {
		return translate(uiLang, source, params);
	}

	function capture(store, el, read) {
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
		return store.get(el);
	}

	function applyStaticText(doc = root && root.document) {
		if (!doc || typeof doc.querySelectorAll !== "function") return;
		if (doc.documentElement) doc.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
		for (const el of doc.querySelectorAll("[data-i18n]")) {
			const record = capture(textSource, el, (node) => node.textContent || "");
			el.textContent = record.lead + t(record.source) + record.tail;
		}
		for (const el of doc.querySelectorAll("[data-i18n-html]")) {
			const record = capture(htmlSource, el, (node) => node.innerHTML || "");
			el.innerHTML = record.lead + t(record.source) + record.tail;
		}
		for (const el of doc.querySelectorAll("[data-i18n-lead]")) {
			if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
			const record = capture(leadSource, el, (node) => node.firstChild.nodeValue || "");
			el.firstChild.nodeValue = record.lead + t(record.source) + record.tail;
		}
		for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
			for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) {
				let record = attrSource.get(el);
				if (!record) {
					record = {};
					attrSource.set(el, record);
				}
				if (!(attr in record)) record[attr] = el.getAttribute(attr) || "";
				el.setAttribute(attr, t(record[attr]));
			}
		}
		for (const el of doc.querySelectorAll(".langOption")) {
			const active = el.dataset.lang === uiLang;
			el.classList.toggle("active", active);
			el.setAttribute("aria-pressed", String(active));
		}
		doc.documentElement.lang = uiLang === "en" ? "en" : "zh-CN";
	}

	function setLanguage(lang, doc = root && root.document) {
		if (!UI_LANGS.includes(lang) || lang === uiLang) return false;
		uiLang = lang;
		const storage = safeStorage();
		try {
			if (storage) storage.setItem(UI_LANG_KEY, lang);
		} catch (error) {
			// Session-only language choice is still useful.
		}
		applyStaticText(doc);
		return true;
	}

	function getLanguage() {
		return uiLang;
	}

	function setLanguageDirect(lang) {
		if (UI_LANGS.includes(lang)) uiLang = lang;
	}

	return {
		EN_TEXT,
		UI_LANG_KEY,
		UI_LANGS,
		applyStaticText,
		detectUiLang,
		getLanguage,
		setLanguage,
		setLanguageDirect,
		t,
		translate,
	};
});
