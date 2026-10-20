const test = require("node:test");
const assert = require("node:assert/strict");

const { computeVerdict, summarizeDmesg, buildReport } = require("../js/domain/diagnostics.js");

function healthyFacts(overrides = {}) {
	return {
		moduleLoaded: true,
		moduleLine: "pathmask 123 0 - Live 0x0",
		bootStateName: "loaded",
		bootStateDetail: "ok",
		bootStateUpdated: Math.floor(Date.now() / 1000) - 60,
		bootStateAgeStr: "1 分钟前",
		nowEpoch: Math.floor(Date.now() / 1000),
		hasBootState: true,
		failCount: 0,
		failReason: "",
		koMissing: false,
		koSha: "abcdef123456",
		koSize: 12345,
		ksuDisabled: false,
		unameR: "6.1.0-android14-11-g1234-ab1234",
		kmi: "android14-6.1",
		oem: null,
		pageSize: "4096",
		selinux: "Enforcing",
		taintInfo: { value: 0, names: [], pretty: "0 (干净)" },
		otherLkms: ["foo"],
		dmesgRaw: "pathmask: loaded -- 2 target(s) hidden, scope=deny",
		dmesgState: { available: true, reason: "" },
		dmesgSummary: {
			loadedLine: "loaded -- 2 target(s) hidden, scope=deny",
			targetLines: [],
			hookedSymbols: ["__arm64_sys_newfstatat"],
			skippedSymbols: [],
			hookFiredFirstTime: ["inode_permission"],
			notFoundLines: [],
			errorLines: [],
		},
		sysfsParams: { scope_mode: "deny", resolved_count: "2", deny_uids: "10100", syscall_hooks: "newfstatat,statx" },
		writePolicyText: "passthrough\n",
		sysResolvedCount: 2,
		confTargetCount: 2,
		confSyscallHooks: "newfstatat,statx",
		confEnableSyscallHooks: "1",
		stale: { scope: false, enableSyscallHooks: false, syscallHooks: false, denyUids: false },
		anyStale: false,
		denyPackagesEntries: [{ pkg: "com.a", uid: "10100" }],
		unresolvedDenyPackages: [],
		resolvedDenyUids: ["10100"],
		orphanDenyUids: [],
		directDenyUids: [],
		allowSystemUids: [],
		...overrides,
	};
}

test("healthy loaded facts produce an ok verdict", () => {
	const verdict = computeVerdict(healthyFacts());
	assert.equal(verdict.level, "ok");
	assert.match(verdict.headline, /PathMask 正在运行/);
});

test("stale config dominates the loaded verdict and suggests reload", () => {
	const verdict = computeVerdict(healthyFacts({
		anyStale: true,
		stale: { scope: true, enableSyscallHooks: false, syscallHooks: false, denyUids: false },
	}));
	assert.equal(verdict.level, "warn");
	assert.match(verdict.headline, /未热重载/);
	assert.match(verdict.suggestions.join("\n"), /保存并热重载/);
});

test("unresolved packages are surfaced in deny mode", () => {
	const verdict = computeVerdict(healthyFacts({
		unresolvedDenyPackages: ["com.missing"],
		denyPackagesEntries: [{ pkg: "com.a", uid: "10100" }, { pkg: "com.missing", uid: null }],
	}));
	assert.equal(verdict.level, "warn");
	assert.match(verdict.headline, /无法解析为 UID/);
	assert.match(verdict.suggestions.join("\n"), /com\.missing/);
});

test("missing boot state points at service.sh scheduling", () => {
	const verdict = computeVerdict(healthyFacts({
		moduleLoaded: false,
		hasBootState: false,
		bootStateName: null,
		koMissing: false,
		failCount: 0,
		ksuDisabled: false,
	}));
	assert.equal(verdict.level, "bad");
	assert.match(verdict.headline, /service\.sh/);
});

test("disabled module and paused module have distinct verdicts", () => {
	const disabled = computeVerdict(healthyFacts({ moduleLoaded: false, ksuDisabled: true, hasBootState: true }));
	assert.equal(disabled.level, "bad");
	assert.match(disabled.headline, /禁用/);

	const paused = computeVerdict(healthyFacts({ moduleLoaded: false, hasBootState: true, bootStateName: "paused" }));
	assert.equal(paused.level, "info");
	assert.match(paused.headline, /暂停/);
});

test("summarizeDmesg extracts load, hook and error lines", () => {
	const summary = summarizeDmesg(`
[ 1.000000] pathmask: loaded -- 2 target(s) hidden, scope=deny
[ 1.100000] pathmask: target[0] /a ino=1 dev=0:1
[ 1.200000] pathmask: hooked __arm64_sys_newfstatat
[ 1.300000] pathmask: skip __arm64_sys_faccessat (disabled)
[ 1.400000] pathmask: inode_permission hook fired (first time)
[ 1.500000] pathmask: /missing not found (err=-2), skip
[ 1.600000] pathmask: disagrees about version of symbol module_layout
`);
	assert.equal(summary.loadedLine, "loaded -- 2 target(s) hidden, scope=deny");
	assert.deepEqual(summary.targetLines, ["/a ino=1 dev=0:1"]);
	assert.deepEqual(summary.hookedSymbols, ["__arm64_sys_newfstatat"]);
	assert.deepEqual(summary.skippedSymbols, ["__arm64_sys_faccessat"]);
	assert.deepEqual(summary.hookFiredFirstTime, ["inode_permission"]);
	assert.equal(summary.notFoundLines.length, 1);
	assert.equal(summary.errorLines.length, 1);
});

test("buildReport contains the verdict, key facts and raw sections", () => {
	const facts = healthyFacts();
	const verdict = computeVerdict(facts);
	const report = buildReport({
		facts,
		verdict,
		moduleProp: "2.8.3",
		configLog: "--- persistent config ---\nscope=deny",
		scriptLog: "pathmask: loaded",
		statusLog: "--- sysfs parameters ---\nscope_mode=deny",
		procguardKoInfo: "missing",
		procguardConfText: "0",
		procguardModuleText: "",
		procguardHits: "",
		procguardMissed: "",
		procguardGid: "",
	});
	assert.match(report, /=== 结论 ===/);
	assert.match(report, /PathMask 正在运行/);
	assert.match(report, /=== 关键事实 ===/);
	assert.match(report, /=== dmesg pathmask 相关 ===/);
	assert.match(report, /scope_mode=deny/);
});

test("enabled procguard with a missing procguard.ko is a warning", () => {
	const verdict = computeVerdict(healthyFacts({ procguard: true, procguardKoMissing: true }));
	assert.equal(verdict.level, "warn");
	assert.match(verdict.headline, /procguard\.ko/);
});

test("buildReport without a snapshot keeps the copyable stub", () => {
	const report = buildReport();
	assert.match(report, /PathMask 诊断报告/);
	assert.match(report, /生成诊断/);
});
