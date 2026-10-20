const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHealthChecks, levelForVerdict } = require("../js/ui/views/diagnostics.js");

const t = (source, params) => String(source).replace(/\{(\d+)\}/g, (match, index) => (
	params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
));

function facts(overrides = {}) {
	return {
		moduleLoaded: true,
		bootStateName: "loaded",
		bootStateDetail: "ok",
		hasBootState: true,
		confTargetCount: 2,
		sysResolvedCount: 2,
		anyStale: false,
		stale: { scope: false, enableSyscallHooks: false, syscallHooks: false, denyUids: false },
		unresolvedDenyPackages: [],
		dmesgState: { available: true, reason: "" },
		dmesgSummary: { errorLines: [], hookFiredFirstTime: [] },
		failCount: 0,
		ksuDisabled: false,
		koMissing: false,
		procguard: false,
		...overrides,
	};
}

test("levelForVerdict maps domain levels to UI levels", () => {
	assert.equal(levelForVerdict("ok"), "ok");
	assert.equal(levelForVerdict("warn"), "warn");
	assert.equal(levelForVerdict("bad"), "danger");
	assert.equal(levelForVerdict("info"), "info");
});

test("healthy facts produce green checks with no warnings", () => {
	const checks = buildHealthChecks(facts(), t);
	assert.ok(checks.length >= 2);
	assert.equal(checks[0].level, "ok");
	assert.equal(checks.some((check) => check.level === "warn" || check.level === "danger"), false);
});

test("stale, unresolved and dmesg errors become actionable warnings", () => {
	const checks = buildHealthChecks(facts({
		anyStale: true,
		stale: { scope: true, enableSyscallHooks: false, syscallHooks: false, denyUids: false },
		unresolvedDenyPackages: ["com.missing"],
		dmesgSummary: { errorLines: ["disagrees about version of symbol"], hookFiredFirstTime: [] },
	}), t);
	assert.equal(checks.some((check) => check.level === "warn" && /未热重载/.test(check.title)), true);
	assert.equal(checks.some((check) => /未解析/.test(check.title)), true);
	assert.equal(checks.some((check) => check.level === "danger" && /内核/.test(check.title)), true);
});

test("not loaded and disabled facts produce a danger check", () => {
	const checks = buildHealthChecks(facts({
		moduleLoaded: false,
		ksuDisabled: true,
		hasBootState: false,
		bootStateName: null,
	}), t);
	assert.equal(checks[0].level, "danger");
	assert.match(checks[0].title, /禁用|未加载/);
});
