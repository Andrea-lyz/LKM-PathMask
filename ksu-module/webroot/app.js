// Set up a global error trap before anything else. If app.js fails to
// parse or any top-level statement throws synchronously, the WebUI
// would otherwise stay frozen on the HTML default status text with
// no clue what went wrong (the bottom-of-file try/catch can't catch
// errors thrown above it). This handler writes the error directly
// into #statusText so we can debug from the WebUI alone, without
// needing chrome://inspect to be reachable.
window.addEventListener("error", (event) => {
	const msg = event && event.message ? event.message : "未知错误";
	const where = event && event.filename
		? `${event.filename}:${event.lineno}:${event.colno}`
		: "";
	const status = document.getElementById("statusText");
	if (status) {
		status.textContent = `脚本错误：${msg} ${where}`;
		status.style.color = "#c01c28";
	}
});
window.addEventListener("unhandledrejection", (event) => {
	const reason = event && event.reason;
	const msg = reason && reason.message ? reason.message
		: typeof reason === "string" ? reason : String(reason);
	const status = document.getElementById("statusText");
	if (status) {
		status.textContent = `Promise 错误：${msg}`;
		status.style.color = "#c01c28";
	}
});

const MODULE_ID = "pathmask";
const LEGACY_MODULE_ID = "nohello-demo";
const MODULE_NAME = "pathmask";
const LEGACY_MODULE_NAME = "nohello";
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

const DEFAULT_WAIT_SECONDS = 60;
const BOOT_POLL_INTERVAL_MS = 5000;
const BOOT_WAITING_STATES = new Set(["init", "waiting-targets", "waiting-packages"]);

const files = {
	targets: `${CONFIGDIR}/target_path.conf`,
	hideDirents: `${CONFIGDIR}/hide_dirents.conf`,
	scope: `${CONFIGDIR}/scope_mode.conf`,
	denyPackages: `${CONFIGDIR}/deny_packages.conf`,
	denyUids: `${CONFIGDIR}/deny_uids.conf`,
	waitSeconds: `${CONFIGDIR}/wait_seconds.conf`,
	enableSyscallHooks: `${CONFIGDIR}/enable_syscall_hooks.conf`,
	syscallHooks: `${CONFIGDIR}/syscall_hooks.conf`,
	bootState: `${CONFIGDIR}/boot_state`,
	failCount: `${CONFIGDIR}/load_fail_count`,
	failReason: `${CONFIGDIR}/load_fail_reason`,
	service: `${MODDIR}/service.sh`,
	ko: `${MODDIR}/pathmask.ko`,
};

let apps = [];
let selectedPackages = new Set();
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
	if (!bridge) throw new Error("KernelSU WebUI API 不可用");

	return new Promise((resolve, reject) => {
		const callbackName = `pathmask_exec_${Date.now()}_${Math.random().toString(16).slice(2)}`;

		window[callbackName] = (errno, stdout, stderr) => {
			delete window[callbackName];
			if (errno && errno !== 0) {
				const err = new Error(stderr || stdout || `命令失败：${errno}`);
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

function setBusy(nextBusy, message) {
	busy = nextBusy;
	for (const button of actionButtons) button.disabled = nextBusy;
	if (message) statusText.textContent = message;
}

async function runAction(message, action) {
	if (busy) {
		showToast("正在处理，请稍等");
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

// Mirror service.sh's accept-list for boolean *.conf files. The kernel
// param itself is bool 0/1, but we accept the same human-friendly values
// here so a manually-edited conf with "true"/"yes" still loads cleanly.
function parseBoolish(text, fallback = false) {
	const v = firstLine(text).toLowerCase();
	if (v === "") return fallback;
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
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
	input.placeholder = "/system/app/example 或 /dev/???/marker";

	const groupInput = document.createElement("input");
	groupInput.type = "text";
	groupInput.className = "pathRowGroup";
	groupInput.value = group;
	groupInput.placeholder = "组";
	groupInput.title = "可选 OR 组名。同名组内任一行命中即视为该组满足，所有未分组的行仍需各自存在";

	const dirToggle = document.createElement("label");
	dirToggle.className = "pathRowDirToggle";
	dirToggle.title = "勾选后隐藏匹配项的父目录（dir:）。对随机父目录场景必须勾选";
	const dirCheckbox = document.createElement("input");
	dirCheckbox.type = "checkbox";
	dirCheckbox.checked = useParent;
	dirToggle.append(dirCheckbox);

	const remove = document.createElement("button");
	remove.type = "button";
	remove.textContent = "删";
	remove.addEventListener("click", () => row.remove());

	row.append(input, groupInput, dirToggle, remove);
	pathList.append(row);
	input.focus();
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
	appList.textContent = "";

	const filtered = apps.filter((app) => !query || app.pkg.toLowerCase().includes(query));
	for (const app of filtered) {
		const row = document.createElement("label");
		row.className = "appRow";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = selectedPackages.has(app.pkg);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) selectedPackages.add(app.pkg);
			else selectedPackages.delete(app.pkg);
			updateHealthList();
		});

		const pkg = document.createElement("div");
		pkg.className = "pkg";
		pkg.textContent = app.pkg;

		const uid = document.createElement("div");
		uid.className = "uid";
		uid.textContent = app.uid;

		row.append(checkbox, pkg, uid);
		appList.append(row);
	}
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
	const scope = snapshot.scopeText?.trim() || "deny";
	const targetCount = linesFromText(snapshot.targetText || "").length || DEFAULT_TARGET_PATHS.length;
	const sysUidCount = countCsv(snapshot.sysDenyUids || "");
	const configUidCount = linesFromText(snapshot.uidText || "").length;

	setText("#moduleState", loaded ? "已加载" : legacyLoaded ? "旧模块已加载" : "未加载");
	setText("#scopeState", scope === "global" ? "全局" : "黑名单");
	setText("#targetCount", String(targetCount));
	setText("#uidCount", String(sysUidCount || configUidCount));
	statusText.textContent = loaded ? "模块已加载" : "模块未加载";
}

function updateHealthList() {
	const snapshot = lastSnapshot;
	const items = [];
	const loaded = snapshot.moduleText?.trim();
	const legacyLoaded = snapshot.legacyModuleText?.trim();
	const scope = (snapshot.scopeText || "deny").trim() === "global" ? "global" : "deny";
	const targets = collectPaths();
	const selected = [...selectedPackages];
	const directUids = linesFromText($("#denyUidsInput").value);
	const sysUids = linesFromText((snapshot.sysDenyUids || "").replace(/,/g, "\n"));
	const loadFailCount = Number.parseInt(firstLine(snapshot.loadFailCountText), 10) || 0;
	const loadFailReason = firstLine(snapshot.loadFailReasonText);

	if (loaded) {
		items.push({ level: "ok", title: "模块已加载", body: loaded });
	} else if (legacyLoaded) {
		items.push({ level: "warn", title: "旧 nohello 模块仍在运行", body: "卸载旧模块并重启后再安装 PathMask。" });
	} else {
		items.push({ level: "bad", title: "模块未加载", body: "查看脚本日志和内核日志，重点找 ko 缺失、KMI 不匹配、UID 为空或目标路径不存在。" });
	}

	const bootStatusItem = describeBootState(snapshot, !!loaded);
	if (bootStatusItem) {
		items.push(bootStatusItem);
	}

	if ((snapshot.koInfo || "").includes("No such file") || (snapshot.koInfo || "").includes("missing")) {
		items.push({ level: "bad", title: "pathmask.ko 不存在", body: `${files.ko} 缺失，重新安装模块包。` });
	} else {
		items.push({ level: "ok", title: "模块文件存在", body: `${files.ko}` });
	}

	if (scope === "deny" && selected.length === 0 && directUids.length === 0 && sysUids.length === 0) {
		items.push({ level: "bad", title: "黑名单为空", body: "deny 模式下没有包名或 UID，service.sh 会跳过加载。" });
	} else if (scope === "deny") {
		items.push({ level: "ok", title: "黑名单模式有目标", body: `包名 ${selected.length} 个，直接 UID ${directUids.length} 个。` });
	}

	if (targets.length === 0) {
		items.push({ level: "bad", title: "隐藏路径为空", body: "至少保留一个存在的路径，否则模块不会加载。" });
	} else if (snapshot.targetProbeHidden) {
		const resolved = Number.isFinite(snapshot.targetResolvedCount) ? snapshot.targetResolvedCount : -1;
		if (resolved < 0) {
			items.push({ level: "ok", title: "隐藏路径配置有效", body: `${targets.length} 条路径（global 模式下被自身隐藏，跳过 stat 探测）。` });
		} else if (resolved === targets.length) {
			items.push({ level: "ok", title: "隐藏路径配置有效", body: `内核已解析 ${resolved}/${targets.length} 条路径（global 模式下 stat 会被自身拦截，故跳过用户态探测）。` });
		} else if (resolved === 0) {
			items.push({ level: "warn", title: "内核未解析到任何路径", body: `配置了 ${targets.length} 条路径但内核加载时全部跳过；可能配置变更后未重启或热重载。` });
		} else {
			items.push({ level: "warn", title: "部分路径未解析", body: `内核仅解析了 ${resolved}/${targets.length} 条路径，剩余的在加载时不存在被跳过；查看 dmesg 找具体哪一条。` });
		}
	} else if ((snapshot.targetProbe || "").includes("MISS")) {
		items.push({ level: "warn", title: "有路径当前不存在", body: "不存在的路径会在内核加载时被跳过。" });
	} else {
		items.push({ level: "ok", title: "隐藏路径配置有效", body: `${targets.length} 条路径。` });
	}

	if (loadFailCount >= 3) {
		items.push({ level: "bad", title: "连续加载失败保护已触发", body: loadFailReason || "保存并热重载会重置保护并重新尝试加载。" });
	} else if (loadFailCount > 0) {
		items.push({ level: "warn", title: "最近发生过加载失败", body: `${loadFailCount}/3：${loadFailReason || "查看内核日志。"}` });
	}

	for (const message of lastValidation.errors) {
		items.push({ level: "bad", title: "配置错误", body: message });
	}
	for (const message of lastValidation.warnings) {
		items.push({ level: "warn", title: "配置警告", body: message });
	}
	for (const message of lastValidation.ok) {
		items.push({ level: "ok", title: "配置校验", body: message });
	}

	if ((snapshot.moduleFlags || "").includes("disable")) {
		items.push({ level: "bad", title: "模块被禁用", body: "删除 disable 文件或在 KernelSU 管理器中启用模块。" });
	}

	if ((snapshot.legacyConfigInfo || "").trim()) {
		items.push({ level: "warn", title: "发现旧配置目录", body: `${LEGACY_CONFIGDIR} 存在，PathMask 会尝试迁移但不会自动删除。` });
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
 * Run all probe shell in one round-trip and parse outputs into a
 * structured facts object. Each section is delimited by a magic
 * marker so we can split reliably even when probes fail mid-stream.
 *
 * Heads up: shell here is run as the WebUI shell user, which on
 * KernelSU is root, but several probes are still gated by SELinux
 * domain (e.g. dmesg under restrict, /sys/kernel/tainted on some
 * builds). We capture the resulting errno + stderr via probeExec()
 * so the verdict can distinguish "feature gone" from "no signal".
 */
async function gatherDiagnosticFacts(snapshot) {
	const sep = "###PMSEP###";
	const result = await probeExec(`
echo ${sep}uname
uname -r 2>&1
echo ${sep}taint
cat /proc/sys/kernel/tainted 2>&1
echo ${sep}dmesgrestrict
cat /proc/sys/kernel/dmesg_restrict 2>&1
echo ${sep}pagesize
getconf PAGE_SIZE 2>&1
echo ${sep}selinux
getenforce 2>&1
echo ${sep}ksum
[ -f ${shellQuote(files.ko)} ] && sha1sum ${shellQuote(files.ko)} 2>&1 | awk '{print $1}' || echo missing
echo ${sep}kosize
[ -f ${shellQuote(files.ko)} ] && stat -c '%s' ${shellQuote(files.ko)} 2>&1 || echo missing
echo ${sep}allmodules
cat /proc/modules 2>&1
echo ${sep}dmesgall
dmesg 2>&1 | grep -Ei 'pathmask|nohello|module_layout|disagrees|unknown symbol|invalid module|exec format' | tail -n 80
true
`);

	const stdout = result.stdout || "";
	const sections = {};
	const re = new RegExp(`^${sep}(\\w+)$`);
	let key = null;
	const lines = stdout.split(/\r?\n/);
	for (const line of lines) {
		const m = line.match(re);
		if (m) {
			key = m[1];
			sections[key] = "";
			continue;
		}
		if (key !== null) {
			sections[key] += (sections[key] ? "\n" : "") + line;
		}
	}

	const trim = (s) => (s || "").trim();
	const allModules = trim(sections.allmodules);
	const ourModule = allModules.split(/\r?\n/).find((l) => l.startsWith("pathmask "));
	const moduleLoaded = !!ourModule;
	const otherLkms = allModules
		.split(/\r?\n/)
		.map((l) => l.split(" ")[0])
		.filter((n) => n && n !== "pathmask" && n !== "nohello");

	const dmesgRaw = trim(sections.dmesgall);
	const dmesgRestrict = trim(sections.dmesgrestrict);
	// dmesg_restrict=1 + empty dmesgRaw == almost certainly EPERM,
	// not "kernel never logged anything about us". Distinguish so the
	// report stops lying about it.
	let dmesgState;
	if (dmesgRaw && !/^cat:|Operation not permitted/i.test(dmesgRaw)) {
		dmesgState = { available: true, reason: "" };
	} else if (dmesgRestrict === "1") {
		dmesgState = {
			available: false,
			reason: "dmesg_restrict=1（系统锁定，root WebUI shell 也无权读，部分 OnePlus / OEM ROM 默认如此）",
		};
	} else if (/Operation not permitted|Permission denied/i.test(dmesgRaw)) {
		dmesgState = { available: false, reason: "权限被拒（SELinux 或 capabilities）" };
	} else {
		dmesgState = { available: false, reason: "dmesg 命令无输出" };
	}

	const koSha = trim(sections.ksum);
	const koSize = trim(sections.kosize);
	const unameR = trim(sections.uname);
	const oem = detectOemKernel(unameR);
	const kmi = detectKmiFromUname(unameR);

	// Match the zip's KMI label (we don't ship it as a file, but
	// the .ko filename in /data/adb/modules/pathmask/ is just
	// pathmask.ko -- the zip suffix is stripped at install time. So
	// we can only detect a mismatch by comparing the kernel's KMI
	// to the user-pickable zip metadata, which we don't have here.
	// Instead we surface the kernel's KMI for the user/dev to
	// eyeball; CRC mismatch will show up as a dmesg disagrees line.)
	let bootStateName = null;
	let bootStateDetail = null;
	if (snapshot.bootState && snapshot.bootState.state) {
		bootStateName = snapshot.bootState.state;
		bootStateDetail = snapshot.bootState.detail || null;
	}

	const failCount = Number.parseInt(firstLine(snapshot.loadFailCountText), 10) || 0;
	const failReason = firstLine(snapshot.loadFailReasonText);
	const koMissing = (snapshot.koInfo || "").includes("missing") ||
		(snapshot.koInfo || "").includes("No such file");
	const ksuDisabled = (snapshot.moduleFlags || "").includes("disable");

	return {
		moduleLoaded,
		moduleLine: ourModule || "",
		bootStateName,
		bootStateDetail,
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
		pageSize: trim(sections.pagesize),
		selinux: trim(sections.selinux),
		taint: trim(sections.taint),
		otherLkms,
		dmesgRaw,
		dmesgState,
		_probeOk: result.ok,
		_probeError: result.error,
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
		return {
			level: FACT_OK,
			headline: "PathMask 正在运行",
			suggestions: [
				"如果实际表现仍异常（被检测到、目标可见），用「校验配置」检查是否所有目标都被解析。",
			],
		};
	}

	if (facts.ksuDisabled) {
		return {
			level: FACT_BAD,
			headline: "模块被 KSU 禁用",
			suggestions: [
				`在 KernelSU 管理器中启用 PathMask，或删除 ${MODDIR}/disable / remove。`,
				"启用后重启或点「保存并热重载」。",
			],
		};
	}

	if (facts.koMissing) {
		return {
			level: FACT_BAD,
			headline: "模块文件 pathmask.ko 缺失",
			suggestions: [
				"重新刷入对应 KMI 的 ksu zip。",
				`确认 ${files.ko} 在重启后存在。`,
			],
		};
	}

	if (facts.failCount >= 3) {
		return {
			level: FACT_BAD,
			headline: `连续 ${facts.failCount} 次 insmod 失败，已自动跳过加载`,
			suggestions: [
				facts.failReason
					? `失败原因：${facts.failReason}`
					: "修复底层原因（看下方建议）后再重试。",
				"在「快速操作」点「校验配置」找具体原因；修好后用「保存并热重载」即可重置失败保护。",
			],
		};
	}

	if (facts.failCount >= 1) {
		return {
			level: FACT_WARN,
			headline: `最近发生过 ${facts.failCount}/3 次 insmod 失败`,
			suggestions: [
				facts.failReason
					? `失败原因：${facts.failReason}`
					: "下次开机会再试一次；继续失败将触发跳过保护。",
				"如果反复失败，多半是 KMI / OEM 内核 CRC 不兼容（看「内核环境」段）。",
			],
		};
	}

	if (facts.bootStateName === "skipped-targets-missing") {
		return {
			level: FACT_WARN,
			headline: "service.sh 等待目标路径超时",
			suggestions: [
				"开机时 wait_seconds 内目标路径仍不可见，所以 service.sh 主动跳过加载（这是预期行为，不算 bug）。",
				"重启一次通常能恢复（系统第一次冷启动挂载较慢）。",
				`如果反复出现，把 ${CONFIGDIR}/wait_seconds.conf 调到 90 或 120 秒。`,
			],
		};
	}

	if (facts.bootStateName === "skipped-no-uids") {
		return {
			level: FACT_WARN,
			headline: "deny 模式下没有解析到任何 UID",
			suggestions: [
				"deny 模式至少需要一个能解析到 UID 的应用。",
				"在「应用黑名单」里勾上想隐藏的应用，或在「直接 UID」里手填，然后保存并重启。",
			],
		};
	}

	if (facts.bootStateName === "skipped-empty-targets") {
		return {
			level: FACT_BAD,
			headline: "目标路径列表为空",
			suggestions: [
				"在「隐藏路径」里至少添加一条路径，否则模块没东西可隐藏，service.sh 会跳过加载。",
			],
		};
	}

	if (facts.bootStateName === "skipped-fail-guard") {
		return {
			level: FACT_BAD,
			headline: "失败保护跳过加载",
			suggestions: [
				"清掉失败计数（点「保存并热重载」会自动清）后再试。",
			],
		};
	}

	if (facts.bootStateName === "skipped-legacy-loaded") {
		return {
			level: FACT_BAD,
			headline: "旧 nohello 模块仍在内核里",
			suggestions: [
				"卸载旧的 nohello 模块再装 PathMask，或者直接在 KernelSU 管理器里把 nohello 禁用并重启。",
			],
		};
	}

	if (facts.bootStateName && facts.bootStateName.startsWith("failed-")) {
		return {
			level: FACT_BAD,
			headline: `service.sh 报告 ${facts.bootStateName}`,
			suggestions: [
				`详情：${facts.bootStateDetail || "无"}`,
				"重点看下方「dmesg pathmask 相关」段，最常见是 KMI / CRC 不匹配。",
			],
		};
	}

	if (facts.bootStateName === "loaded" && !facts.moduleLoaded) {
		return {
			level: FACT_BAD,
			headline: "service.sh 觉得加载成功，但 /proc/modules 里没有 pathmask",
			suggestions: [
				"模块加载后又被卸载了，或者 insmod 返回 0 但内核拒绝了模块。",
				"重启一次再生成诊断；仍然这样的话看「dmesg pathmask 相关」段（如果可读）。",
			],
		};
	}

	if (facts.bootStateName && BOOT_WAITING_STATES.has(facts.bootStateName)) {
		return {
			level: FACT_INFO,
			headline: `service.sh 仍在 ${facts.bootStateName} 阶段`,
			suggestions: [
				"等几秒后再生成诊断，让开机脚本走完。",
			],
		};
	}

	if (facts.bootStateName === "paused") {
		return {
			level: FACT_INFO,
			headline: "用户从 WebUI 暂停了隐藏",
			suggestions: [
				"点「保存并热重载」恢复。",
			],
		};
	}

	if (!facts.hasBootState) {
		return {
			level: FACT_BAD,
			headline: "service.sh 似乎从未被调度执行",
			suggestions: [
				"没有 /data/adb/pathmask/boot_state 说明开机脚本根本没跑过。",
				"先重启一次（这一类问题在 OnePlus / OxygenOS 上首次安装后很常见，重启后正常）。",
				"重启后还是这样，确认 KSU 管理器里 PathMask 是「已启用」状态。",
			],
		};
	}

	return {
		level: FACT_BAD,
		headline: "模块未加载，原因不在已知列表里",
		suggestions: [
			"先重启一次（很多偶发问题靠重启就能解决）。",
			"还有问题的话，从 root shell 跑：`insmod /data/adb/modules/pathmask/pathmask.ko ; echo exit=$?` 看完整错误，然后把这份诊断 + 这条命令的输出发给开发者。",
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
		"模块加载状态",
		facts.moduleLoaded ? FACT_OK : FACT_BAD,
		facts.moduleLoaded ? facts.moduleLine : "未在 /proc/modules",
	));
	lines.push(fmtFactRow(
		"模块文件",
		facts.koMissing ? FACT_BAD : FACT_OK,
		facts.koMissing
			? `${files.ko} 缺失`
			: `${facts.koSize} 字节, sha1=${(facts.koSha || "?").slice(0, 12)}`,
	));
	lines.push(fmtFactRow(
		"KSU 启用",
		facts.ksuDisabled ? FACT_BAD : FACT_OK,
		facts.ksuDisabled ? "模块被禁用（disable / remove flag）" : "未被禁用",
	));
	if (facts.hasBootState) {
		const detail = facts.bootStateDetail ? `（detail=${facts.bootStateDetail}）` : "";
		lines.push(fmtFactRow(
			"开机阶段",
			facts.bootStateName === "loaded" && facts.moduleLoaded ? FACT_OK :
				(facts.bootStateName && facts.bootStateName.startsWith("skipped-") ? FACT_WARN :
					(facts.bootStateName && facts.bootStateName.startsWith("failed-") ? FACT_BAD : FACT_INFO)),
			`${facts.bootStateName || "?"}${detail}`,
		));
	} else {
		lines.push(fmtFactRow("开机阶段", FACT_BAD, "boot_state 不存在（service.sh 未执行）"));
	}
	const failLevel = facts.failCount >= 3 ? FACT_BAD : facts.failCount > 0 ? FACT_WARN : FACT_OK;
	lines.push(fmtFactRow("失败计数", failLevel, `${facts.failCount} / 3${facts.failReason ? ` (${facts.failReason})` : ""}`));
	const otherCount = facts.otherLkms.length;
	const otherSummary = otherCount === 0
		? "无"
		: `${facts.otherLkms.slice(0, 5).join(", ")}${otherCount > 5 ? ` … (共 ${otherCount} 个)` : ""}`;
	lines.push(fmtFactRow(
		"其他 LKM",
		otherCount > 0 ? FACT_OK : FACT_INFO,
		otherCount > 0 ? `${otherSummary}（说明本机能加载 LKM）` : otherSummary,
	));
	return lines.join("\n");
}

function buildKernelEnv(facts) {
	const lines = [];
	lines.push(fmtFactRow("内核版本", FACT_INFO, facts.unameR || "(读不到 uname -r)"));
	if (facts.kmi) {
		lines.push(fmtFactRow("内核 KMI", FACT_INFO, `${facts.kmi}（请确认安装的 zip 也是这个 KMI）`));
	}
	if (facts.oem) {
		lines.push(fmtFactRow(
			"OEM 后缀",
			FACT_WARN,
			`${facts.oem.tag}（${facts.oem.vendor}）— OEM 改过 GKI，CRC 偶尔会不兼容；如果 dmesg 报 disagrees about version of symbol，需要换 SukiSU / KernelPatch 或自编内核`,
		));
	}
	if (facts.pageSize) {
		lines.push(fmtFactRow(
			"Page size",
			FACT_INFO,
			`${facts.pageSize}（如果 insmod 报 invalid module format，多半是 page size 不一致）`,
		));
	}
	if (facts.selinux) {
		lines.push(fmtFactRow("SELinux", FACT_INFO, facts.selinux));
	}
	if (facts.taint) {
		lines.push(fmtFactRow("内核污染位", facts.taint === "0" ? FACT_OK : FACT_INFO, facts.taint));
	}
	lines.push(fmtFactRow(
		"dmesg 权限",
		facts.dmesgState.available ? FACT_OK : FACT_WARN,
		facts.dmesgState.available ? "可读" : facts.dmesgState.reason,
	));
	return lines.join("\n");
}

function buildReport(snapshot = lastSnapshot) {
	const facts = snapshot.facts;
	const verdict = snapshot.verdict;
	if (!facts || !verdict) {
		// First call before refreshDiagnostics has populated facts.
		// Return a stub so the textarea isn't empty.
		return "PathMask 诊断报告\n（点「生成诊断」后这里会出现可复制报告）";
	}

	const parts = [
		"PathMask 诊断报告",
		`生成时间: ${new Date().toLocaleString()}`,
		`模块版本: ${snapshot.moduleProp || "?"}`,
		"",
		"=== 结论 ===",
		`${STATUS_GLYPH[verdict.level] || "·"} ${verdict.headline}`,
		...(verdict.suggestions.length
			? ["", "建议：", ...verdict.suggestions.map((s, i) => `  ${i + 1}. ${s}`)]
			: []),
		"",
		"=== 关键事实 ===",
		buildKeyFacts(facts),
		"",
		"=== 内核环境 ===",
		buildKernelEnv(facts),
		"",
		"=== 配置文件 ===",
		snapshot.configLog || "(未采集)",
		"",
		"=== 脚本日志 logcat ===",
		snapshot.scriptLog && !/^ERROR:/.test(snapshot.scriptLog) && snapshot.scriptLog.trim()
			? snapshot.scriptLog
			: `(无 pathmask 相关 logcat${snapshot.scriptLogReason ? `；${snapshot.scriptLogReason}` : ""})`,
		"",
		"=== dmesg pathmask 相关 ===",
		facts.dmesgState.available
			? (facts.dmesgRaw || "(dmesg 中没有 pathmask 相关行)")
			: `(dmesg 不可读：${facts.dmesgState.reason})`,
		"",
		"=== 原始数据 ===",
		"--- 模块状态 ---",
		snapshot.statusLog || "(未采集)",
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
		showToast("没有可复制内容");
		return;
	}

	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			showToast("已复制");
			return;
		} catch (error) {
			/* Fall back to textarea copy below. */
		}
	}

	const area = document.createElement("textarea");
	area.value = text;
	document.body.append(area);
	area.select();
	document.execCommand("copy");
	area.remove();
	showToast("已复制");
}

async function loadApps() {
	statusText.textContent = "正在加载应用...";
	const showSystem = $("#showSystemInput").checked;
	const command = showSystem ? "pm list packages -U" : "pm list packages -U -3";
	const output = await execShell(command);
	apps = output.split(/\r?\n/)
		.map(parsePackageLine)
		.filter(Boolean)
		.sort((a, b) => a.pkg.localeCompare(b.pkg));
	renderApps();
	showToast(`已加载 ${apps.length} 个应用`);
}

async function refreshConfig() {
	const targetText = await readFile(files.targets);
	const hideText = await readFile(files.hideDirents);
	const scopeText = await readFile(files.scope);
	const pkgText = await readFile(files.denyPackages);
	const uidText = await readFile(files.denyUids);
	const waitText = await readFile(files.waitSeconds);
	const enableSyscallHooksText = await readFile(files.enableSyscallHooks);
	const syscallHooksText = await readFile(files.syscallHooks);
	const bootStateText = await readFile(files.bootState);
	const moduleText = await safeExec(`grep '^${MODULE_NAME} ' /proc/modules || true`);
	const legacyModuleText = await safeExec(`grep '^${LEGACY_MODULE_NAME} ' /proc/modules || true`);
	const sysDenyUids = await safeExec(`[ -f /sys/module/${MODULE_NAME}/parameters/deny_uids ] && cat /sys/module/${MODULE_NAME}/parameters/deny_uids || true`);
	const sysResolvedCount = await safeExec(`[ -f /sys/module/${MODULE_NAME}/parameters/resolved_count ] && cat /sys/module/${MODULE_NAME}/parameters/resolved_count || true`);
	const koInfo = await safeExec(`[ -f ${shellQuote(files.ko)} ] && ls -l ${shellQuote(files.ko)} || echo missing`);
	const moduleFlags = await safeExec(`ls -1 ${shellQuote(MODDIR)}/disable ${shellQuote(MODDIR)}/remove 2>/dev/null || true`);
	const legacyConfigInfo = await safeExec(`[ -d ${shellQuote(LEGACY_CONFIGDIR)} ] && echo ${shellQuote(LEGACY_CONFIGDIR)} || true`);
	const loadFailCountText = await readFile(files.failCount);
	const loadFailReasonText = await readFile(files.failReason);
	const nowText = await safeExec(`date +%s 2>/dev/null || echo 0`);

	renderPaths(linesFromText(targetText));
	$("#hideDirentsInput").checked = (hideText.trim() || "1") !== "0";
	$("#enableSyscallHooksInput").checked = parseBoolish(enableSyscallHooksText, true);
	applySyscallHooksToCheckboxes(syscallHooksText);
	updateSyscallHooksDisabledState();
	const scope = (scopeText.trim() || "deny") === "global" ? "global" : "deny";
	document.querySelector(`input[name="scope"][value="${scope}"]`).checked = true;
	const packageLines = linesFromText(pkgText);
	selectedPackages = new Set(packageLines.length ? packageLines : DEFAULT_DENY_PACKAGES);
	$("#denyUidsInput").value = linesFromText(uidText).join("\n");
	$("#waitSecondsInput").value = parseWaitSeconds(waitText);
	renderApps();

	lastSnapshot = {
		...lastSnapshot,
		targetText,
		hideText,
		scopeText,
		pkgText,
		uidText,
		waitText,
		enableSyscallHooksText,
		bootStateText,
		bootState: parseBootState(bootStateText),
		nowEpoch: Number.parseInt((nowText || "0").trim(), 10) || 0,
		moduleText,
		legacyModuleText,
		sysDenyUids,
		sysResolvedCount,
		koInfo,
		moduleFlags,
		legacyConfigInfo,
		loadFailCountText,
		loadFailReasonText,
	};

	await refreshTargetProbe();
	updateSummary(lastSnapshot);
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

function stopBootPolling() {
	if (bootPollHandle) {
		clearInterval(bootPollHandle);
		bootPollHandle = null;
	}
}

function scheduleBootPolling(bootState) {
	if (!bootState || !BOOT_WAITING_STATES.has(bootState.state)) {
		stopBootPolling();
		return;
	}
	if (bootPollHandle) return;
	bootPollHandle = setInterval(() => {
		if (busy) return;
		readFile(files.bootState).then((text) => {
			const next = parseBootState(text);
			lastSnapshot.bootStateText = text;
			lastSnapshot.bootState = next;
			return safeExec(`date +%s 2>/dev/null || echo 0`).then((nowText) => {
				lastSnapshot.nowEpoch = Number.parseInt((nowText || "0").trim(), 10) || 0;
				updateHealthList();
				if (!BOOT_WAITING_STATES.has(next.state)) stopBootPolling();
			});
		}).catch(() => {});
	}, BOOT_POLL_INTERVAL_MS);
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
				title: "开机服务正在准备",
				body: "service.sh 已开始执行，正在加载配置。",
			};
		case "waiting-targets":
			return {
				level: "warn",
				title: "正在等待隐藏路径出现",
				body: remaining > 0
					? `还需等待最多 ${remaining} 秒，超时仍不存在的路径会被跳过。${detailSuffix}`
					: `等待已超时，模块可能已跳过加载。${detailSuffix}`,
			};
		case "waiting-packages":
			return {
				level: "warn",
				title: "正在等待包名解析为 UID",
				body: remaining > 0
					? `还需等待最多 ${remaining} 秒，超时未解析到 UID 会跳过加载。${detailSuffix}`
					: `等待已超时，模块可能已跳过加载。${detailSuffix}`,
			};
		case "loaded":
			return null;
		case "already-loaded":
			return moduleLoaded ? null : {
				level: "warn",
				title: "上次开机时模块已存在",
				body: "service.sh 检测到 pathmask 已被加载，跳过 insmod。",
			};
		case "skipped-targets-missing":
			return {
				level: "warn",
				title: "所有隐藏路径在等待结束时仍不存在",
				body: `service.sh 跳过加载。可调大等待秒数或检查路径是否拼写正确。${detailSuffix}`,
			};
		case "skipped-no-uids":
			return {
				level: "warn",
				title: "deny 模式下未解析到任何 UID",
				body: `service.sh 跳过加载。检查包名是否拼写正确，或填写直接 UID。${detailSuffix}`,
			};
		case "skipped-empty-targets":
			return {
				level: "bad",
				title: "隐藏路径配置为空",
				body: `service.sh 立即退出。${detailSuffix}`,
			};
		case "skipped-fail-guard":
			return {
				level: "bad",
				title: "连续加载失败保护跳过加载",
				body: `保存并热重载会重置保护并重试。${detailSuffix}`,
			};
		case "skipped-legacy-loaded":
			return {
				level: "warn",
				title: "旧 nohello 模块占据内核",
				body: `卸载旧模块后重启即可加载 PathMask。${detailSuffix}`,
			};
		case "failed-missing-ko":
			return {
				level: "bad",
				title: "pathmask.ko 文件丢失",
				body: `重新安装模块包。${detailSuffix}`,
			};
		case "failed-insmod":
			return {
				level: "bad",
				title: "insmod 失败",
				body: `查看内核日志找 vermagic / unknown symbol / module_layout 等原因。${detailSuffix}`,
			};
		case "paused":
			return {
				level: "warn",
				title: "WebUI 已暂停隐藏",
				body: "热重载或重启后会恢复加载。",
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
	 * In global scope, the module's own syscall hooks intercept stat()
	 * for every UID -- including this WebUI shell. A direct `[ -e ]`
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
	const scope = (lastSnapshot.scopeText || "").trim();
	if (loaded && scope === "global") {
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
	const scope = document.querySelector('input[name="scope"]:checked')?.value || "global";
	const directUids = linesFromText($("#denyUidsInput").value);
	const packages = [...selectedPackages].sort();

	if (!paths.length) {
		errors.push("隐藏路径为空。");
	}

	for (const rawLine of paths) {
		const { path, group } = splitTargetLine(rawLine);
		if (!path.startsWith("/")) {
			errors.push(`隐藏路径必须是绝对路径：${rawLine}`);
		}
		if (rawLine.includes(",")) {
			errors.push(`隐藏路径不能包含英文逗号：${rawLine}`);
		}
		if (group && /[:\s]/.test(group)) {
			errors.push(`组名不能包含冒号或空白：${rawLine}`);
		}
		if (seenPaths.has(rawLine)) {
			warnings.push(`重复路径会被重复传入内核：${rawLine}`);
		}
		seenPaths.add(rawLine);
	}

	for (const uid of directUids) {
		if (!/^\d+$/.test(uid)) {
			errors.push(`UID 只能填写数字：${uid}`);
		}
	}

	const waitRaw = $("#waitSecondsInput").value.trim();
	if (!waitRaw) {
		warnings.push(`等待秒数为空，将使用默认值 ${DEFAULT_WAIT_SECONDS}。`);
	} else if (!/^\d+$/.test(waitRaw)) {
		errors.push(`等待秒数只能填写正整数：${waitRaw}`);
	} else {
		const waitNum = Number.parseInt(waitRaw, 10);
		if (waitNum <= 0) {
			errors.push("等待秒数必须大于 0。");
		} else if (waitNum > 600) {
			warnings.push(`等待秒数较大（${waitNum}s），开机加载会变慢。`);
		}
	}

	if (scope === "deny" && packages.length === 0 && directUids.length === 0) {
		errors.push("黑名单模式下至少需要选择一个包名或填写一个 UID。");
	}

	if (requireModuleFile && ((lastSnapshot.koInfo || "").includes("missing") ||
	    (lastSnapshot.koInfo || "").includes("No such file"))) {
		errors.push(`模块文件不存在：${files.ko}`);
	}

	await refreshTargetProbe();
	if (lastSnapshot.targetProbeHidden) {
		const resolved = Number.isFinite(lastSnapshot.targetResolvedCount) ? lastSnapshot.targetResolvedCount : -1;
		if (resolved >= 0 && resolved < paths.length) {
			warnings.push(`内核仅解析了 ${resolved}/${paths.length} 条路径（global 模式下 stat 会被自身拦截，跳过用户态校验）。`);
		}
	} else {
		const probeLines = linesFromText(lastSnapshot.targetProbe || "");
		const missLines = probeLines.filter((line) => line.startsWith("MISS "));
		if (paths.length && missLines.length === paths.length) {
			warnings.push("当前所有隐藏路径都不存在，service.sh 会等待后跳过加载。");
		} else if (missLines.length) {
			warnings.push(`${missLines.length} 条隐藏路径当前不存在，内核加载时会跳过这些路径。`);
		}
	}

	if (scope === "deny" && packages.length) {
		const packageProbe = await safeExec(`
for p in ${packages.map(shellQuote).join(" ")}; do
	if [ -f /data/system/packages.list ] && grep -q "^$p " /data/system/packages.list 2>/dev/null; then
		echo "OK $p"
	else
		echo "MISS $p"
	fi
done
true
`);
		const packageProbeLines = linesFromText(packageProbe);
		const missingPackages = packageProbeLines.filter((line) => line.startsWith("MISS "));
		if (missingPackages.length === packages.length && directUids.length === 0) {
			warnings.push("当前选择的包名可能都无法解析 UID，开机服务可能会跳过加载。");
		} else if (missingPackages.length) {
			warnings.push(`${missingPackages.length} 个包名当前未在 packages.list 中找到。`);
		}
	}

	if (!errors.length && !warnings.length) {
		ok.push("配置校验通过。");
	}

	lastValidation = { errors, warnings, ok };
	updateHealthList();

	if (errors.length) {
		statusText.textContent = "配置校验未通过";
		showToast(`配置有 ${errors.length} 个错误`);
		if (throwOnError) throw new Error(errors[0]);
		return false;
	}

	statusText.textContent = warnings.length ? "配置校验有警告" : "配置校验通过";
	showToast(warnings.length ? `校验完成：${warnings.length} 个警告` : "配置校验通过");
	return true;
}

async function saveConfig() {
	await validateConfig({ throwOnError: true });
	const scope = document.querySelector('input[name="scope"]:checked')?.value || "global";
	await writeLines(files.targets, collectPaths());
	await writeLines(files.hideDirents, [$("#hideDirentsInput").checked ? "1" : "0"]);
	await writeLines(files.enableSyscallHooks, [$("#enableSyscallHooksInput").checked ? "1" : "0"]);
	await writeLines(files.syscallHooks, [collectSyscallHooks().join(",")]);
	await writeLines(files.scope, [scope]);
	await writeLines(files.denyPackages, [...selectedPackages].sort());
	await writeLines(files.denyUids, linesFromText($("#denyUidsInput").value));
	await writeLines(files.waitSeconds, [String(currentWaitSeconds())]);
	await refreshConfig();
	statusText.textContent = "已保存，重启后生效";
	showToast("已保存，重启后生效");
}

async function reloadModule() {
	await validateConfig({ throwOnError: true, requireModuleFile: true });
	const scope = document.querySelector('input[name="scope"]:checked')?.value || "global";
	await writeLines(files.targets, collectPaths());
	await writeLines(files.hideDirents, [$("#hideDirentsInput").checked ? "1" : "0"]);
	await writeLines(files.enableSyscallHooks, [$("#enableSyscallHooksInput").checked ? "1" : "0"]);
	await writeLines(files.syscallHooks, [collectSyscallHooks().join(",")]);
	await writeLines(files.scope, [scope]);
	await writeLines(files.denyPackages, [...selectedPackages].sort());
	await writeLines(files.denyUids, linesFromText($("#denyUidsInput").value));
	await writeLines(files.waitSeconds, [String(currentWaitSeconds())]);
	statusText.textContent = "正在热重载...";
	const output = await execShell(
		`rm -f ${shellQuote(files.failCount)} ${shellQuote(files.failReason)} 2>/dev/null || true; if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME}; fi; PATHMASK_RESET_FAIL_GUARD=1 PATHMASK_IGNORE_FAIL_GUARD=1 PATHMASK_WAIT_SECONDS=5 sh ${shellQuote(files.service)}; dmesg | grep -Ei 'pathmask|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
	);
	setLogContent("kernel", output);
	await refreshDiagnostics();
	showToast("热重载完成");
}

async function pauseHiding() {
	const output = await execShell(
		`if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME}; log -p i -t pathmask 'hidden paths paused from WebUI'; printf 'state=paused\\nupdated=%s\\ndetail=paused via WebUI\\n' "$(date +%s 2>/dev/null || echo 0)" > ${shellQuote(files.bootState)} 2>/dev/null || true; echo 'pathmask unloaded'; else echo 'pathmask is not loaded'; fi; dmesg | grep -Ei 'pathmask|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`
	);
	setLogContent("kernel", output);
	await refreshDiagnostics();
	statusText.textContent = "隐藏已暂停，热重载可恢复";
	showToast("隐藏已暂停");
}

async function restoreDefaults() {
	await writeLines(files.targets, DEFAULT_TARGET_PATHS);
	await writeLines(files.hideDirents, ["1"]);
	await writeLines(files.enableSyscallHooks, ["1"]);
	await writeLines(files.syscallHooks, [DEFAULT_SYSCALL_HOOKS.join(",")]);
	await writeLines(files.scope, ["deny"]);
	await writeLines(files.denyPackages, DEFAULT_DENY_PACKAGES);
	await writeLines(files.denyUids, []);
	await writeLines(files.waitSeconds, [String(DEFAULT_WAIT_SECONDS)]);
	await refreshConfig();
	showToast("已恢复默认配置，重启后生效");
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
grep -E '^(pathmask|nohello) ' /proc/modules 2>/dev/null || true
echo '--- module files ---'
ls -l ${shellQuote(MODDIR)} 2>/dev/null || true
ls -l ${shellQuote(LEGACY_MODDIR)} 2>/dev/null || true
echo '--- sysfs parameters ---'
for f in /sys/module/pathmask/parameters/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done
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
echo '--- legacy config ---'
for f in ${shellQuote(LEGACY_CONFIGDIR)}/*.conf; do [ -f "$f" ] && echo "### $f" && cat "$f" && echo; done
echo '--- target existence ---'
if [ -f ${shellQuote(files.targets)} ]; then
  scope=$(cat ${shellQuote(files.scope)} 2>/dev/null | head -n1 | tr -d ' \\t\\r\\n')
  loaded=$(grep -c '^${MODULE_NAME} ' /proc/modules 2>/dev/null || echo 0)
  if [ "$scope" = "global" ] && [ "$loaded" -gt 0 ]; then
    resolved=$(cat /sys/module/${MODULE_NAME}/parameters/resolved_count 2>/dev/null || echo ?)
    echo "(scope=global, kernel resolved $resolved target(s); skipping user-space stat probe to avoid self-hide)"
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
		scriptLogReason = `logcat 不可读（${scriptProbe.stderr || scriptProbe.error || `errno=${scriptProbe.errno}`}）`;
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
		? (facts.dmesgRaw || "(dmesg 中没有 pathmask 相关行)")
		: `(dmesg 不可读：${facts.dmesgState.reason})`;

	setLogContent("status", statusLog);
	setLogContent("config", configLog);
	setLogContent("script", scriptLog || `(${scriptLogReason || "无 pathmask 相关 logcat"})`);
	setLogContent("kernel", lastSnapshot.kernelLog);
	renderVerdictPanel(lastSnapshot);
	lastReport = buildReport(lastSnapshot);
	$("#reportOutput").value = lastReport;
	statusText.textContent = "诊断已生成";
	showToast("诊断报告已生成");
	updateHealthList();
}

function switchTab(tab) {
	for (const button of $$(".tab")) {
		button.classList.toggle("active", button.dataset.tab === tab);
	}
	for (const panel of $$(".tabPanel")) {
		panel.classList.toggle("active", panel.id === `${tab}Panel`);
	}
}

function switchLog(log) {
	activeLog = log;
	activeLogPage = 0;
	for (const button of $$(".logTab")) {
		button.classList.toggle("active", button.dataset.log === log);
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
$("#loadAppsBtn").addEventListener("click", () => runAction("正在加载应用...", loadApps).catch(() => {}));
$("#refreshBtn").addEventListener("click", () => runAction("正在刷新...", refreshConfig).catch(() => {}));

// Live-update the per-syscall sub-panel disabled state when the master
// toggle is flipped, so it visibly tracks the dependency without waiting
// for the next refresh.
$("#enableSyscallHooksInput").addEventListener("change", updateSyscallHooksDisabledState);
$("#searchInput").addEventListener("input", renderApps);
$("#saveBtn").addEventListener("click", () => runAction("正在保存...", saveConfig).catch(() => {}));
$("#pauseBtn").addEventListener("click", () => runAction("正在暂停隐藏...", pauseHiding).catch(() => {}));
$("#reloadBtn").addEventListener("click", () => runAction("正在热重载...", reloadModule).catch(() => {}));
$("#runDiagnosticBtn").addEventListener("click", () => runAction("正在生成诊断...", refreshDiagnostics).catch(() => {}));
$("#validateConfigBtn").addEventListener("click", () => runAction("正在校验配置...", () => validateConfig()).catch(() => {}));
$("#refreshLogsBtn").addEventListener("click", () => runAction("正在刷新日志...", refreshDiagnostics).catch(() => {}));
$("#copyReportBtn").addEventListener("click", () => copyText(lastReport || buildReport()).catch((error) => showToast(error.message)));
$("#copyReportBtn2").addEventListener("click", () => copyText($("#reportOutput").value).catch((error) => showToast(error.message)));
$("#resetDefaultsBtn").addEventListener("click", () => runAction("正在恢复默认配置...", restoreDefaults).catch(() => {}));
$("#prevLogBtn").addEventListener("click", () => {
	activeLogPage -= 1;
	renderLogPage();
});
$("#nextLogBtn").addEventListener("click", () => {
	activeLogPage += 1;
	renderLogPage();
});

for (const button of $$(".tab")) {
	button.addEventListener("click", () => switchTab(button.dataset.tab));
}

for (const button of $$(".logTab")) {
	button.addEventListener("click", () => switchLog(button.dataset.log));
}

for (const radio of document.querySelectorAll('input[name="scope"]')) {
	radio.addEventListener("change", () => {
		updateHealthList();
		if (radio.value === "deny" && radio.checked && apps.length === 0) {
			loadApps().catch(() => {});
		}
	});
}

$("#denyUidsInput").addEventListener("input", updateHealthList);
$("#waitSecondsInput").addEventListener("input", updateHealthList);

try {
	runAction("正在读取配置...", refreshConfig).catch((error) => {
		statusText.textContent = "读取失败";
		showToast(error.message);
	});
} catch (error) {
	// Synchronous failure during top-level setup. Surface it loudly
	// so the WebUI doesn't get stuck on the HTML default status text
	// with no clue what went wrong.
	statusText.textContent = "脚本初始化失败";
	if (typeof toast !== "undefined" && toast) {
		toast.textContent = error && error.message ? error.message : String(error);
		toast.hidden = false;
	}
	throw error;
}
