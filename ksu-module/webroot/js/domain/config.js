/*
 * Configuration model for PathMask.
 *
 * The on-disk format is deliberately boring: one value per file, one
 * list item per line. These functions are the only place that knows
 * those names and formats. The UI edits a config object; this module
 * serializes it back byte-for-byte in the shapes service.sh expects.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../core/format.js") : root.PathMask.format;
	const bridge = isNode ? require("../core/bridge.js") : (root.PathMask && root.PathMask.bridge);
	const api = factory(root, format, bridge);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.config = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format, bridge) {
	"use strict";

	const MODULE_ID = "pathmask";
	const MODDIR = `/data/adb/modules/${MODULE_ID}`;
	const CONFIGDIR = "/data/adb/pathmask";

	const CONFIG_FILES = {
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
		procguard: `${CONFIGDIR}/procguard.conf`,
		writePolicy: `${CONFIGDIR}/write_op_policy.conf`,
	};

	const DEFAULT_DENY_PACKAGES = [
		"com.chunqiunativecheck",
		"com.eltavine.duckdetector",
		"luna.safe.luna",
	];

	const DEFAULT_CONFIG = {
		scope: "deny",
		paths: [],
		hideDirents: true,
		procguard: false,
		writePolicy: "passthrough",
		syscallEnabled: true,
		syscallHooks: new Set(format.DEFAULT_SYSCALL_HOOKS),
		autoSceneDebugfs: false,
		waitSeconds: format.DEFAULT_WAIT_SECONDS,
		allowSystemUids: new Set(format.DEFAULT_ALLOW_SYSTEM_UIDS),
		denyPackages: new Set(DEFAULT_DENY_PACKAGES),
		allowPackages: new Set(),
		denyUids: [],
		allowUids: [],
	};

	function text(value) {
		return value === undefined || value === null ? "" : String(value);
	}

	function configFromTexts(texts = {}) {
		const paths = format.linesFromText(texts.targets)
			.map((line) => format.splitTargetLine(line))
			.filter((item) => item.path)
			.map((item) => ({ path: item.path, useParent: item.useParent, group: item.group }));

		const denyPackages = format.linesFromText(texts.denyPackages);
		const allowPackages = format.linesFromText(texts.allowPackages);
		const allowSystemUids = texts.allowSystemUids === undefined
			? new Set(format.DEFAULT_ALLOW_SYSTEM_UIDS)
			: format.parseAllowSystemUidsText(texts.allowSystemUids);

		const writePolicyRaw = format.firstLine(texts.writePolicy) || "passthrough";
		const writePolicy = ["passthrough", "eacces", "enoent"].includes(writePolicyRaw)
			? writePolicyRaw
			: "passthrough";

		return {
			scope: format.normalizeScope(format.firstLine(texts.scope)),
			paths,
			hideDirents: (text(texts.hideDirents).trim() || "1") !== "0",
			procguard: format.parseBoolish(texts.procguard, false),
			writePolicy,
			syscallEnabled: format.parseBoolish(texts.enableSyscallHooks, true),
			syscallHooks: format.parseSyscallHooksText(texts.syscallHooks),
			autoSceneDebugfs: format.parseBoolish(texts.autoSceneDebugfs, false),
			waitSeconds: format.parseWaitSeconds(texts.waitSeconds),
			allowSystemUids,
			denyPackages: new Set(denyPackages.length ? denyPackages : DEFAULT_DENY_PACKAGES),
			allowPackages: new Set(allowPackages),
			denyUids: format.linesFromText(texts.denyUids),
			allowUids: format.linesFromText(texts.allowUids),
		};
	}

	function listText(values) {
		const list = values instanceof Set ? [...values] : (Array.isArray(values) ? values : []);
		return list.length ? `${list.join("\n")}\n` : "";
	}

	function boolText(value) {
		return value ? "1\n" : "0\n";
	}

	function serializeConfig(config) {
		const targetLines = (config.paths || [])
			.map((item) => format.joinTargetLine(item.path, item.useParent, item.group))
			.filter(Boolean);
		return {
			[CONFIG_FILES.targets]: targetLines.length ? `${targetLines.join("\n")}\n` : "",
			[CONFIG_FILES.hideDirents]: boolText(config.hideDirents),
			[CONFIG_FILES.scope]: `${format.normalizeScope(config.scope)}\n`,
			[CONFIG_FILES.denyPackages]: listText(config.denyPackages),
			[CONFIG_FILES.denyUids]: listText(config.denyUids),
			[CONFIG_FILES.allowPackages]: listText(config.allowPackages),
			[CONFIG_FILES.allowUids]: listText(config.allowUids),
			[CONFIG_FILES.allowSystemUids]: listText(config.allowSystemUids),
			[CONFIG_FILES.waitSeconds]: `${config.waitSeconds || format.DEFAULT_WAIT_SECONDS}\n`,
			[CONFIG_FILES.enableSyscallHooks]: boolText(config.syscallEnabled),
			[CONFIG_FILES.syscallHooks]: `${[...(config.syscallHooks || [])].join(",")}\n`,
			[CONFIG_FILES.autoSceneDebugfs]: boolText(config.autoSceneDebugfs),
			[CONFIG_FILES.procguard]: boolText(config.procguard),
			[CONFIG_FILES.writePolicy]: `${config.writePolicy || "passthrough"}\n`,
		};
	}

	function validateConfig(config, t = (source, params) => String(source).replace(/\{(\d+)\}/g, (match, index) => (
		params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
	))) {
		const errors = [];
		const warnings = [];
		const seen = new Set();

		for (const item of config.paths || []) {
			const path = text(item.path).trim();
			if (!path) continue;
			if (!path.startsWith("/")) {
				errors.push(t("路径必须是绝对路径：{0}", [path]));
			}
			if (/\s/.test(path)) {
				errors.push(t("路径不能包含空白字符：{0}", [path]));
			}
			if (item.group && /[\s:]/.test(item.group)) {
				errors.push(t("OR 组名不能包含空格或冒号：{0}", [item.group]));
			}
			const key = format.joinTargetLine(path, item.useParent, item.group);
			if (seen.has(key)) errors.push(t("路径重复：{0}", [key]));
			seen.add(key);
		}

		for (const uid of [...(config.denyUids || []), ...(config.allowUids || [])]) {
			if (!/^\d+$/.test(text(uid).trim())) errors.push(t("UID 必须是数字：{0}", [uid]));
		}
		for (const uid of config.allowSystemUids || []) {
			if (!/^\d+$/.test(text(uid).trim())) errors.push(t("系统 UID 必须是数字：{0}", [uid]));
		}

		const wait = Number(config.waitSeconds);
		if (!Number.isFinite(wait) || wait < 1 || wait > 600) {
			errors.push(t("等待秒数必须在 1–600 之间"));
		}

		if (!(config.paths || []).length) {
			warnings.push(t("还没有隐藏路径，模块加载后不会隐藏任何文件。"));
		}
		if (config.scope === "allow" && !(config.allowPackages || new Set()).size && !(config.allowUids || []).length) {
			warnings.push(t("白名单模式没有选择任何应用或 UID，所有应用都会被隐藏。"));
		}
		if (config.scope === "deny" && !(config.denyPackages || new Set()).size && !(config.denyUids || []).length) {
			warnings.push(t("黑名单模式没有选择任何应用或 UID，隐藏不会作用于任何应用。"));
		}
		if (config.scope === "global" && ((config.denyPackages || new Set()).size || (config.allowPackages || new Set()).size)) {
			warnings.push(t("全局模式会忽略应用列表；已选应用会保留但不参与判断。"));
		}

		return { ok: errors.length === 0, errors, warnings };
	}

	async function readFile(path, bridgeOverride) {
		const exec = bridge && bridge.execShell;
		if (!exec) throw new Error("KernelSU WebUI API 不可用");
		return exec(`[ -f ${format.shellQuote(path)} ] && cat ${format.shellQuote(path)} || true`, { bridge: bridgeOverride });
	}

	async function readFileOrDefault(path, defaultLines, bridgeOverride) {
		const exec = bridge && bridge.execShell;
		if (!exec) throw new Error("KernelSU WebUI API 不可用");
		const quoted = format.shellQuote(path);
		const fallback = defaultLines && defaultLines.length
			? `printf '%s\\n' ${defaultLines.map(format.shellQuote).join(" ")}`
			: "true";
		return exec(`[ -f ${quoted} ] && cat ${quoted} || ${fallback}`, { bridge: bridgeOverride });
	}

	async function readConfig(options = {}) {
		const bridge = options.bridge;
		const entries = await Promise.all([
			readFile(CONFIG_FILES.targets, bridge),
			readFile(CONFIG_FILES.hideDirents, bridge),
			readFile(CONFIG_FILES.scope, bridge),
			readFile(CONFIG_FILES.denyPackages, bridge),
			readFile(CONFIG_FILES.denyUids, bridge),
			readFile(CONFIG_FILES.allowPackages, bridge),
			readFile(CONFIG_FILES.allowUids, bridge),
			readFileOrDefault(CONFIG_FILES.allowSystemUids, format.DEFAULT_ALLOW_SYSTEM_UIDS, bridge),
			readFile(CONFIG_FILES.waitSeconds, bridge),
			readFile(CONFIG_FILES.enableSyscallHooks, bridge),
			readFile(CONFIG_FILES.syscallHooks, bridge),
			readFile(CONFIG_FILES.autoSceneDebugfs, bridge),
			readFile(CONFIG_FILES.procguard, bridge),
			readFile(CONFIG_FILES.writePolicy, bridge),
		]);
		const texts = {
			targets: entries[0],
			hideDirents: entries[1],
			scope: entries[2],
			denyPackages: entries[3],
			denyUids: entries[4],
			allowPackages: entries[5],
			allowUids: entries[6],
			allowSystemUids: entries[7],
			waitSeconds: entries[8],
			enableSyscallHooks: entries[9],
			syscallHooks: entries[10],
			autoSceneDebugfs: entries[11],
			procguard: entries[12],
			writePolicy: entries[13],
		};
		return { config: configFromTexts(texts), texts };
	}

	async function writeText(path, content, bridgeOverride) {
		const exec = bridge && bridge.execShell;
		if (!exec) throw new Error("KernelSU WebUI API 不可用");
		const body = content === ""
			? `: > ${format.shellQuote(path)}`
			: `printf '%s' ${format.shellQuote(content)} > ${format.shellQuote(path)}`;
		await exec(`mkdir -p ${format.shellQuote(CONFIGDIR)}; chmod 0700 ${format.shellQuote(CONFIGDIR)} 2>/dev/null || true; ${body}`, { bridge: bridgeOverride });
	}

	async function writeConfig(config, options = {}) {
		const bridge = options.bridge;
		const serialized = serializeConfig(config);
		for (const [path, content] of Object.entries(serialized)) {
			await writeText(path, content, bridge);
		}
		return serialized;
	}

	return {
		CONFIGDIR,
		CONFIG_FILES,
		DEFAULT_CONFIG,
		DEFAULT_DENY_PACKAGES,
		MODDIR,
		configFromTexts,
		readConfig,
		readFile,
		readFileOrDefault,
		serializeConfig,
		validateConfig,
		writeConfig,
		writeText,
	};
});
