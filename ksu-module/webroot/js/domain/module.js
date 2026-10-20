/*
 * Module lifecycle commands.
 *
 * All writes go through config.js first, then a single shell command
 * unloads and restarts service.sh. Keeping the command in one place
 * means the apply path and the explicit "pause" path cannot drift.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../core/format.js") : root.PathMask.format;
	const bridge = isNode ? require("../core/bridge.js") : root.PathMask.bridge;
	const config = isNode ? require("./config.js") : root.PathMask.config;
	const api = factory(root, format, bridge, config);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.module = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format, bridge, config) {
	"use strict";

	const MODULE_NAME = "pathmask";
	const PROCGUARD_NAME = "procguard";
	const LEGACY_NAME = "nohello";
	const SERVICE = `${config.MODDIR}/service.sh`;
	const PROCGUARD_KO = `${config.MODDIR}/procguard.ko`;
	const BOOT_STATE = `${config.CONFIGDIR}/boot_state`;
	const SCENE_STATE = `${config.CONFIGDIR}/scene_debugfs_state`;
	const SCENE_PATHS = `${config.CONFIGDIR}/scene_debugfs_paths`;
	const SCENE_STOP = `${config.CONFIGDIR}/scene_debugfs_watch.stop`;
	const FAIL_COUNT = `${config.CONFIGDIR}/load_fail_count`;
	const FAIL_REASON = `${config.CONFIGDIR}/load_fail_reason`;
	const WAITING_STATES = new Set(["init", "waiting-targets", "waiting-packages"]);

	function tr(source, params) {
		const api = root && root.PathMask && root.PathMask.i18n;
		if (api && typeof api.t === "function") return api.t(source, params);
		return String(source).replace(/\{(\d+)\}/g, (match, index) => (
			params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
		));
	}

	function buildReloadCommand(servicePath = SERVICE) {
		return [
			// Always unload the optional guard before restarting service.sh.
			// Otherwise turning procguard off would write procguard.conf=0 but
			// leave the already-loaded ko in place until the next reboot.
			`if grep -q '^${PROCGUARD_NAME} ' /proc/modules 2>/dev/null; then rmmod ${PROCGUARD_NAME} 2>/dev/null || true; fi`,
			`rm -f ${format.shellQuote(SCENE_STOP)} ${format.shellQuote(FAIL_COUNT)} ${format.shellQuote(FAIL_REASON)} 2>/dev/null || true`,
			`if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME} || exit 20; fi`,
			`if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then echo 'pathmask is still loaded after rmmod' >&2; exit 21; fi`,
			`PATHMASK_RESET_FAIL_GUARD=1 PATHMASK_IGNORE_FAIL_GUARD=1 PATHMASK_INITIAL_DELAY_SECONDS=0 PATHMASK_WAIT_SECONDS=5 sh ${format.shellQuote(servicePath)}`,
			`rc=$?`,
			`dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`,
			`if [ "$rc" -ne 0 ]; then echo "service.sh failed (exit $rc)" >&2; fi`,
			`exit "$rc"`,
		].join("; ");
	}

	function buildPauseCommand(bootStatePath = BOOT_STATE) {
		return [
			`touch ${format.shellQuote(SCENE_STOP)} 2>/dev/null || true`,
			`if grep -q '^${MODULE_NAME} ' /proc/modules 2>/dev/null; then rmmod ${MODULE_NAME}; log -p i -t pathmask 'hidden paths paused from WebUI'; printf 'state=paused\\nupdated=%s\\ndetail=paused via WebUI\\n' "$(date +%s 2>/dev/null || echo 0)" > ${format.shellQuote(bootStatePath)} 2>/dev/null || true; echo 'pathmask unloaded'; else printf 'state=paused\\nupdated=%s\\ndetail=paused via WebUI\\n' "$(date +%s 2>/dev/null || echo 0)" > ${format.shellQuote(bootStatePath)} 2>/dev/null || true; echo 'pathmask is not loaded'; fi`,
			`dmesg | grep -Ei 'pathmask|procguard|nohello|unknown symbol|invalid module|exec format|module_layout' | tail -n 30`,
		].join("; ");
	}

	function restoreDefaultsConfig() {
		return {
			scope: "deny",
			paths: format.DEFAULT_TARGET_PATHS.map((line) => format.splitTargetLine(line)),
			hideDirents: true,
			procguard: false,
			writePolicy: "passthrough",
			syscallEnabled: true,
			syscallHooks: new Set(format.DEFAULT_SYSCALL_HOOKS),
			autoSceneDebugfs: false,
			waitSeconds: format.DEFAULT_WAIT_SECONDS,
			allowSystemUids: new Set(format.DEFAULT_ALLOW_SYSTEM_UIDS),
			denyPackages: new Set(config.DEFAULT_DENY_PACKAGES),
			allowPackages: new Set(),
			denyUids: [],
			allowUids: [],
		};
	}

	function normalizeStatus(input = {}) {
		const moduleText = String(input.moduleText || "").trim();
		const legacyText = String(input.legacyModuleText || "").trim();
		const boot = format.parseBootState(input.bootStateText || "");
		const scene = format.parseSceneDebugfsState(input.sceneStateText || "");
		const procguardLoaded = /^procguard\s/m.test(String(input.procguardModuleText || ""));
		const failCount = Number.parseInt(String(input.failCountText || "0").trim(), 10) || 0;
		const loaded = moduleText.length > 0;
		const legacyLoaded = legacyText.length > 0;
		const waiting = WAITING_STATES.has(boot.state);
		const paused = boot.state === "paused";
		const failed = boot.state === "failed" || failCount > 0;
		let level = "info";
		if (loaded) level = "ok";
		else if (failed) level = "danger";
		else if (waiting) level = "warn";
		else if (paused) level = "info";
		else if (boot.state) level = "warn";
		else level = "danger";
		return {
			level,
			loaded,
			legacyLoaded,
			waiting,
			paused,
			failed,
			failCount,
			boot,
			scene,
			procguardLoaded,
			moduleText,
			legacyModuleText: legacyText,
			procguardModuleText: String(input.procguardModuleText || ""),
		};
	}

	async function probeStatus(options = {}) {
		const bridgeApi = options.bridge || bridge;
		const exec = (command) => bridgeApi.safeExec(command, { bridge: options.ksu });
		const [moduleText, legacyModuleText, bootStateText, sceneStateText, scenePathsText, procguardModuleText, procguardKoText, resolvedCountText, failCountText, failReasonText, procguardConfText, writePolicyText] = await Promise.all([
			exec(`grep '^${MODULE_NAME} ' /proc/modules || true`),
			exec(`grep '^${LEGACY_NAME} ' /proc/modules || true`),
			exec(`[ -f ${format.shellQuote(BOOT_STATE)} ] && cat ${format.shellQuote(BOOT_STATE)} || true`),
			exec(`[ -f ${format.shellQuote(SCENE_STATE)} ] && cat ${format.shellQuote(SCENE_STATE)} || true`),
			exec(`[ -s ${format.shellQuote(SCENE_PATHS)} ] && cat ${format.shellQuote(SCENE_PATHS)} || true`),
			exec(`grep '^${PROCGUARD_NAME} ' /proc/modules || true`),
			exec(`[ -f ${format.shellQuote(PROCGUARD_KO)} ] && echo present || echo missing`),
			exec(`[ -f /sys/module/${MODULE_NAME}/parameters/resolved_count ] && cat /sys/module/${MODULE_NAME}/parameters/resolved_count || true`),
			exec(`[ -f ${format.shellQuote(FAIL_COUNT)} ] && cat ${format.shellQuote(FAIL_COUNT)} || true`),
			exec(`[ -f ${format.shellQuote(FAIL_REASON)} ] && cat ${format.shellQuote(FAIL_REASON)} || true`),
			exec(`[ -f ${format.shellQuote(config.CONFIG_FILES.procguard)} ] && cat ${format.shellQuote(config.CONFIG_FILES.procguard)} || true`),
			exec(`[ -f ${format.shellQuote(config.CONFIG_FILES.writePolicy)} ] && cat ${format.shellQuote(config.CONFIG_FILES.writePolicy)} || true`),
		]);
		const resolvedCountRaw = String(resolvedCountText || "").trim();
		const resolvedCount = /^\d+$/.test(resolvedCountRaw) ? Number(resolvedCountRaw) : -1;
		return {
			...normalizeStatus({
				moduleText,
				legacyModuleText,
				bootStateText,
				sceneStateText,
				procguardModuleText,
				failCountText,
			}),
			scenePaths: format.linesFromText(scenePathsText),
			failReason: String(failReasonText || "").trim(),
			procguardConf: format.parseBoolish(procguardConfText, false),
			procguardKo: String(procguardKoText || "").trim() === "present" ? "present" : "missing",
			resolvedCount,
			writePolicy: format.firstLine(writePolicyText) || "passthrough",
		};
	}

	async function preflightConfig(configObject, status = {}, options = {}) {
		const bridgeApi = options.bridge || bridge;
		const exec = (command) => bridgeApi.safeExec(command, { bridge: options.ksu });
		const t = typeof options.t === "function" ? options.t : tr;
		const errors = [];
		const warnings = [];
		const scope = format.normalizeScope(configObject.scope);
		const paths = (configObject.paths || []).filter((item) => String(item.path || "").trim());

		if (options.requireModule) {
			const ko = await exec(`[ -f ${format.shellQuote(`${config.MODDIR}/pathmask.ko`)} ] && echo present || echo missing`);
			if (String(ko || "").trim() !== "present") {
				errors.push(t("模块文件不存在：{0}", [`${config.MODDIR}/pathmask.ko`]));
			}
		}

		// In global/allow mode a loaded module may hide the probe path from the
		// WebUI's own shell. The kernel resolved_count is authoritative there.
		const probeHidden = !!(status.loaded && (scope === "global" || scope === "allow"));
		if (paths.length && probeHidden) {
			const resolved = Number.isFinite(status.resolvedCount) ? status.resolvedCount : -1;
			if (resolved >= 0 && resolved < paths.length) {
				warnings.push(t("内核仅解析了 {0}/{1} 条路径（当前模式下 stat 会被自身拦截，跳过用户态校验）。", [resolved, paths.length]));
			}
		}
		if (paths.length && !probeHidden) {
			const safe = /^[A-Za-z0-9_./?*@+=,-]+$/;
			const probes = [];
			paths.forEach((item, index) => {
				const path = String(item.path || "").trim();
				if (!safe.test(path)) return;
				if (path.includes("?") || path.includes("*")) {
					const glob = path.replace(/\?/g, "*");
					probes.push(`if ls -d ${glob} >/dev/null 2>&1; then echo "${index}=1"; else echo "${index}=0"; fi`);
				} else {
					probes.push(`if [ -e ${format.shellQuote(path)} ]; then echo "${index}=1"; else echo "${index}=0"; fi`);
				}
			});
			if (probes.length) {
				const output = await exec(`${probes.join("; ")}; true`);
				const missing = [];
				for (const line of String(output || "").split(/\r?\n/)) {
					const match = line.trim().match(/^(\d+)=([01])$/);
					if (match && match[2] === "0") missing.push(paths[Number(match[1])]);
				}
				if (missing.length === paths.length) {
					warnings.push(t("当前所有隐藏路径都不存在，service.sh 会等待后跳过加载。"));
				} else if (missing.length) {
					warnings.push(t("{0} 条隐藏路径当前不存在，内核加载时会跳过这些路径。", [missing.length]));
				}
			}
		}

		if (scope === "deny" || scope === "allow") {
			const packages = [...(scope === "allow" ? configObject.allowPackages : configObject.denyPackages) || []];
			if (packages.length) {
				const quoted = packages.map((pkg) => format.shellQuote(pkg)).join(" ");
				const output = await exec(`
for p in ${quoted}; do
	if [ -f /data/system/packages.list ] && grep -q "^$p " /data/system/packages.list 2>/dev/null; then
		echo "OK $p"
	else
		echo "MISS $p"
	fi
done
true`);
				const missing = String(output || "").split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line.startsWith("MISS "))
					.map((line) => line.slice(5));
				if (missing.length === packages.length) {
					warnings.push(t("当前选择的包名可能都无法解析 UID，开机服务可能会跳过加载。"));
				} else if (missing.length) {
					warnings.push(t("{0} 个包名当前未在 packages.list 中找到。", [missing.length]));
				}
			}
		}

		return { ok: errors.length === 0, errors, warnings };
	}

	async function saveOnly(configObject, options = {}) {
		await config.writeConfig(configObject, { bridge: options.bridge });
		return configObject;
	}

	async function reloadModule(configObject, options = {}) {
		const bridgeApi = options.bridge || bridge;
		const ko = await bridgeApi.safeExec(
			`[ -f ${format.shellQuote(`${config.MODDIR}/pathmask.ko`)} ] && echo present || echo missing`,
			{ bridge: options.ksu },
		);
		if (String(ko || "").trim() !== "present") {
			throw new Error(tr("模块文件不存在：{0}", [`${config.MODDIR}/pathmask.ko`]));
		}
		await config.writeConfig(configObject, { bridge: options.bridge });
		const output = await bridgeApi.execShell(buildReloadCommand(options.servicePath), { bridge: options.ksu });
		return { output, status: await probeStatus({ bridge: bridgeApi, ksu: options.ksu }) };
	}

	async function pauseHiding(options = {}) {
		const bridgeApi = options.bridge || bridge;
		const output = await bridgeApi.execShell(buildPauseCommand(options.bootStatePath), { bridge: options.ksu });
		return { output, status: await probeStatus({ bridge: bridgeApi, ksu: options.ksu }) };
	}

	async function restoreDefaults(options = {}) {
		const defaults = restoreDefaultsConfig();
		await config.writeConfig(defaults, { bridge: options.bridge });
		return defaults;
	}

	return {
		BOOT_STATE,
		FAIL_COUNT,
		FAIL_REASON,
		MODULE_NAME,
		SCENE_PATHS,
		SCENE_STATE,
		SERVICE,
		buildPauseCommand,
		buildReloadCommand,
		normalizeStatus,
		pauseHiding,
		preflightConfig,
		probeStatus,
		reloadModule,
		restoreDefaults,
		restoreDefaultsConfig,
		saveOnly,
	};
});
