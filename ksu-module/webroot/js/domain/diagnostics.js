/*
 * Diagnostics domain.
 *
 * The rule engine and report builder are ported from the previous
 * monolithic app.js without changing the verdict ordering or report
 * wording. Collection is separate: the UI calls collectSnapshot() on
 * demand, never during initial page load.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../core/format.js") : root.PathMask.format;
	const bridge = isNode ? require("../core/bridge.js") : root.PathMask.bridge;
	const config = isNode ? require("./config.js") : root.PathMask.config;
	const moduleApi = isNode ? require("./module.js") : root.PathMask.module;
	const i18n = isNode ? require("../core/i18n.js") : root.PathMask.i18n;
	const api = factory(root, format, bridge, config, moduleApi, i18n);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.diagnostics = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format, bridge, config, moduleApi, i18n) {
	"use strict";

	const t = (source, params) => i18n.t(source, params);
	const shellQuote = format.shellQuote;
	const linesFromText = format.linesFromText;
	const firstLine = format.firstLine;
	const normalizeScope = format.normalizeScope;
	const parseAllowSystemUidsText = format.parseAllowSystemUidsText;
	const parseBoolish = format.parseBoolish;
	const MODDIR = config.MODDIR;
	const CONFIGDIR = config.CONFIGDIR;
	const files = {
		...config.CONFIG_FILES,
		ko: `${MODDIR}/pathmask.ko`,
		procguardKo: `${MODDIR}/procguard.ko`,
		procguardConf: config.CONFIG_FILES.procguard,
		writeOpPolicy: config.CONFIG_FILES.writePolicy,
		service: `${MODDIR}/service.sh`,
		bootState: `${CONFIGDIR}/boot_state`,
		sceneDebugfsState: `${CONFIGDIR}/scene_debugfs_state`,
		sceneDebugfsPaths: `${CONFIGDIR}/scene_debugfs_paths`,
		loadFailCount: `${CONFIGDIR}/load_fail_count`,
		loadFailReason: `${CONFIGDIR}/load_fail_reason`,
	};
	const BOOT_WAITING_STATES = new Set(["init", "waiting-targets", "waiting-packages"]);
	const probeExec = (command) => bridge.probeExec(command);
	const safeExec = (command) => bridge.safeExec(command);

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
		procguard: parseBoolish(snapshot.procguardConfText, false),
		procguardLoaded: /^procguard\s/m.test(String(snapshot.procguardModuleText || "")),
		procguardKoMissing: String(snapshot.procguardKoInfo || "").trim() !== "present",
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
		if (facts.procguard && facts.procguardKoMissing) {
			return {
				level: FACT_WARN,
				headline: t("隔离防护已启用，但 procguard.ko 缺失"),
				suggestions: [
					t("当前模块包未包含 procguard.ko，隔离防护无法加载。"),
					t("重新刷入包含 procguard.ko 的模块包，或在设置中关闭隔离防护。"),
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

function buildReport(snapshot = null) {
	const facts = snapshot && snapshot.facts;
	const verdict = snapshot && snapshot.verdict;
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

	const STATUS_LOG_PROBE = `
echo '--- modules ---'
grep -E '^(pathmask|procguard|nohello) ' /proc/modules 2>/dev/null || true
echo '--- module files ---'
ls -l ${shellQuote(MODDIR)} 2>/dev/null || true
echo '--- sysfs parameters ---'
for f in /sys/module/pathmask/parameters/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done
echo '--- procguard parameters ---'
for f in /sys/module/procguard/parameters/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done
echo '--- load failure guard ---'
[ -f ${shellQuote(files.loadFailCount)} ] && echo "load_fail_count=$(cat ${shellQuote(files.loadFailCount)} 2>/dev/null)" || echo "load_fail_count=0"
[ -f ${shellQuote(files.loadFailReason)} ] && echo "load_fail_reason=$(cat ${shellQuote(files.loadFailReason)} 2>/dev/null)"
true
`;

	const CONFIG_LOG_PROBE = `
echo '--- persistent config ---'
for f in ${shellQuote(CONFIGDIR)}/*.conf; do [ -f "$f" ] && echo "### $f" && cat "$f" && echo; done
echo '--- boot state ---'
if [ -f ${shellQuote(files.bootState)} ]; then cat ${shellQuote(files.bootState)} 2>/dev/null; else echo "(no boot_state file -- service.sh did not run, or persist dir is unwritable)"; fi
echo '--- Scene debugfs auto-discovery ---'
if [ -f ${shellQuote(files.sceneDebugfsState)} ]; then cat ${shellQuote(files.sceneDebugfsState)} 2>/dev/null; else echo "(no scene_debugfs_state)"; fi
if [ -s ${shellQuote(files.sceneDebugfsPaths)} ]; then echo 'runtime paths:'; cat ${shellQuote(files.sceneDebugfsPaths)} 2>/dev/null; fi
true
`;

	async function collectSnapshot(options = {}) {
		const configResult = await config.readConfig({ bridge: options.ksu });
		const status = await moduleApi.probeStatus({ ksu: options.ksu });
		const texts = configResult.texts;
		const scope = normalizeScope(texts.scope);
		const snapshot = {
			...texts,
			pkgText: scope === "allow" ? texts.allowPackages : texts.denyPackages,
			uidText: scope === "allow" ? texts.allowUids : texts.denyUids,
			allowSystemUidText: texts.allowSystemUids,
			bootState: status.boot,
			bootStateText: await safeExec(`[ -f ${shellQuote(files.bootState)} ] && cat ${shellQuote(files.bootState)} || true`),
			nowEpoch: Math.floor(Date.now() / 1000),
			writePolicyText: texts.writePolicy,
			loadFailCountText: String(status.failCount || 0),
			loadFailReasonText: status.failReason || "",
			koInfo: await safeExec(`[ -f ${shellQuote(files.ko)} ] && ls -l ${shellQuote(files.ko)} || echo missing`),
			moduleFlags: await safeExec(`ls -1 ${shellQuote(MODDIR)}/disable ${shellQuote(MODDIR)}/remove 2>/dev/null || true`),
			procguardKoInfo: await safeExec(`[ -f ${shellQuote(files.procguardKo)} ] && echo present || echo missing`),
			procguardModuleText: status.procguardModuleText || "",
			procguardConfText: texts.procguard,
			procguardHits: await safeExec(`[ -f /sys/module/procguard/parameters/blocked_hits ] && cat /sys/module/procguard/parameters/blocked_hits || true`),
			procguardMissed: await safeExec(`[ -f /sys/module/procguard/parameters/missed ] && cat /sys/module/procguard/parameters/missed || true`),
			procguardGid: await safeExec(`[ -f /sys/module/procguard/parameters/target_gid ] && cat /sys/module/procguard/parameters/target_gid || true`),
			moduleProp: "",
			statusLog: "",
			configLog: "",
			scriptLog: "",
			scriptLogReason: "",
		};
		const [statusLog, configLog, scriptLog, moduleProp] = await Promise.all([
			safeExec(STATUS_LOG_PROBE),
			safeExec(CONFIG_LOG_PROBE),
			safeExec("logcat -d -s pathmask 2>/dev/null | tail -n 100 || true"),
			safeExec(`grep '^version=' ${shellQuote(MODDIR)}/module.prop 2>/dev/null | head -n1 || true`),
		]);
		snapshot.statusLog = statusLog;
		snapshot.configLog = configLog;
		snapshot.scriptLog = scriptLog;
		snapshot.moduleProp = firstLine(moduleProp).replace(/^version=/, "") || "?";
		const facts = await gatherDiagnosticFacts(snapshot);
		const verdict = computeVerdict(facts);
		const report = buildReport({ ...snapshot, facts, verdict });
		return { snapshot: { ...snapshot, facts, verdict }, facts, verdict, report, config: configResult.config, status };
	}

	return {
		buildReport,
		collectSnapshot,
		computeVerdict,
		gatherDiagnosticFacts,
		summarizeDmesg,
	};
});
