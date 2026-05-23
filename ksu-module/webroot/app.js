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
	"/dev/scene",
	"/system_ext/app/SoterService",
];

const DEFAULT_DENY_PACKAGES = [
	"com.chunqiunativecheck",
	"com.eltavine.duckdetector",
	"luna.safe.luna",
];

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
				reject(new Error(stderr || stdout || `命令失败：${errno}`));
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

function setText(selector, value) {
	const node = $(selector);
	if (node) node.textContent = value;
}

function renderPaths(paths) {
	pathList.textContent = "";
	const list = paths.length ? paths : DEFAULT_TARGET_PATHS;
	for (const path of list) addPathRow(path);
}

function addPathRow(value = "") {
	const row = document.createElement("div");
	row.className = "pathRow";

	const input = document.createElement("input");
	input.type = "text";
	input.value = value;
	input.placeholder = "/system/app/example";

	const remove = document.createElement("button");
	remove.type = "button";
	remove.textContent = "删";
	remove.addEventListener("click", () => row.remove());

	row.append(input, remove);
	pathList.append(row);
	input.focus();
}

function collectPaths() {
	return [...pathList.querySelectorAll("input")]
		.map((input) => input.value.trim())
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

function buildReport(snapshot = lastSnapshot) {
	const parts = [
		"PathMask 诊断报告",
		`生成时间: ${new Date().toLocaleString()}`,
		"",
		"=== 模块状态 ===",
		snapshot.statusLog || "(未生成)",
		"",
		"=== 配置文件 ===",
		snapshot.configLog || "(未生成)",
		"",
		"=== 脚本日志 logcat ===",
		snapshot.scriptLog || "(未生成)",
		"",
		"=== 内核日志 dmesg ===",
		snapshot.kernelLog || "(未生成)",
	];
	return parts.join("\n");
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
	$("#enableSyscallHooksInput").checked = parseBoolish(enableSyscallHooksText, false);
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

	const body = paths.map((path) => (
		`if [ -e ${shellQuote(path)} ]; then echo OK ${shellQuote(path)}; else echo MISS ${shellQuote(path)}; fi`
	)).join("; ");
	lastSnapshot.targetProbe = await safeExec(body);
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

	for (const path of paths) {
		if (!path.startsWith("/")) {
			errors.push(`隐藏路径必须是绝对路径：${path}`);
		}
		if (path.includes(",")) {
			errors.push(`隐藏路径不能包含英文逗号：${path}`);
		}
		if (seenPaths.has(path)) {
			warnings.push(`重复路径会被重复传入内核：${path}`);
		}
		seenPaths.add(path);
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
	await writeLines(files.enableSyscallHooks, ["0"]);
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
    while IFS= read -r p || [ -n "$p" ]; do [ -z "$p" ] && continue; case "$p" in \\#*) continue;; esac; if [ -e "$p" ]; then echo "OK $p"; else echo "MISS $p"; fi; done < ${shellQuote(files.targets)}
  fi
fi
true
`);

	const scriptLog = await safeExec(`logcat -d -s pathmask nohello 2>/dev/null | tail -n 300 || true`);
	const kernelLog = await safeExec(`dmesg 2>/dev/null | grep -Ei 'pathmask|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 240 || true`);

	lastSnapshot = {
		...lastSnapshot,
		statusLog,
		configLog,
		scriptLog,
		kernelLog,
	};

	setLogContent("status", statusLog);
	setLogContent("config", configLog);
	setLogContent("script", scriptLog);
	setLogContent("kernel", kernelLog);
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

$("#addPathBtn").addEventListener("click", () => addPathRow());
$("#loadAppsBtn").addEventListener("click", () => runAction("正在加载应用...", loadApps).catch(() => {}));
$("#refreshBtn").addEventListener("click", () => runAction("正在刷新...", refreshConfig).catch(() => {}));
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

runAction("正在读取配置...", refreshConfig).catch((error) => {
	statusText.textContent = "读取失败";
	showToast(error.message);
});
