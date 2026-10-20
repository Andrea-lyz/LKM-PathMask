const test = require("node:test");
const assert = require("node:assert/strict");

const moduleApi = require("../js/domain/module.js");

test("buildReloadCommand unloads, clears guards and restarts service.sh", () => {
	const command = moduleApi.buildReloadCommand("/data/adb/modules/pathmask/service.sh");
	assert.match(command, /rmmod pathmask/);
	assert.match(command, /PATHMASK_RESET_FAIL_GUARD=1/);
	assert.match(command, /PATHMASK_WAIT_SECONDS=5/);
	assert.match(command, /sh '\/data\/adb\/modules\/pathmask\/service\.sh'/);
	assert.match(command, /dmesg/);
});

test("buildPauseCommand writes a paused boot state and unloads the module", () => {
	const command = moduleApi.buildPauseCommand("/data/adb/pathmask/boot_state");
	assert.match(command, /state=paused/);
	assert.match(command, /rmmod pathmask/);
	assert.match(command, /paused via WebUI/);
});

test("restoreDefaults returns the same defaults the old UI wrote", () => {
	const config = moduleApi.restoreDefaultsConfig();
	assert.equal(config.scope, "deny");
	assert.equal(config.hideDirents, true);
	assert.equal(config.syscallEnabled, true);
	assert.equal(config.autoSceneDebugfs, false);
	assert.equal(config.waitSeconds, 60);
	assert.deepEqual(config.paths.map((item) => item.path), [
		"/dev/cpuset/scene-daemon",
		"/dev/???/scene_mode_category",
		"/system_ext/app/SoterService",
	]);
	assert.deepEqual([...config.denyPackages], [
		"com.chunqiunativecheck",
		"com.eltavine.duckdetector",
		"luna.safe.luna",
	]);
	assert.deepEqual(config.denyUids, []);
	assert.deepEqual(config.allowUids, []);
});

test("normalizeStatus distinguishes loaded, boot-waiting and paused", () => {
	const loaded = moduleApi.normalizeStatus({
		moduleText: "pathmask 12345 0 - Live 0x0000000000000000",
		bootStateText: "state=loaded\nupdated=10\ndeadline=20\ndetail=ok\n",
	});
	assert.equal(loaded.level, "ok");
	assert.equal(loaded.loaded, true);

	const waiting = moduleApi.normalizeStatus({
		moduleText: "",
		bootStateText: "state=waiting-targets\nupdated=10\ndeadline=70\ndetail=waiting\n",
	});
	assert.equal(waiting.level, "warn");
	assert.equal(waiting.waiting, true);

	const paused = moduleApi.normalizeStatus({
		moduleText: "",
		bootStateText: "state=paused\nupdated=10\ndeadline=0\ndetail=paused\n",
	});
	assert.equal(paused.level, "info");
	assert.equal(paused.paused, true);
});

test("buildReloadCommand unloads procguard even when the new config disables it", () => {
	const command = moduleApi.buildReloadCommand("/data/adb/modules/pathmask/service.sh");
	assert.match(command, /grep -q '\^procguard ' \/proc\/modules/);
	assert.doesNotMatch(command, /grep -q '\^1'.*procguard\.conf/);
});

function fakeBridge(handler) {
	const commands = [];
	return {
		commands,
		safeExec: async (command) => {
			commands.push(command);
			return handler(command);
		},
	};
}

test("buildReloadCommand propagates service.sh failure after printing dmesg", () => {
	const command = moduleApi.buildReloadCommand("/data/adb/modules/pathmask/service.sh");
	assert.match(command, /rc=\$\?/);
	assert.match(command, /service\.sh failed \(exit \$rc\)/);
	assert.match(command, /exit "\$rc"/);
});

test("preflightConfig blocks a missing module file and warns about missing targets and packages", async () => {
	const missingKo = await moduleApi.preflightConfig(
		{ paths: [], scope: "global", allowPackages: new Set(), denyPackages: new Set() },
		{},
		{
			requireModule: true,
			bridge: fakeBridge((command) => command.includes("pathmask.ko") ? "missing" : ""),
		},
	);
	assert.equal(missingKo.ok, false);
	assert.match(missingKo.errors.join("\n"), /pathmask\.ko/);

	const bridge = fakeBridge((command) => {
		if (command.includes("pathmask.ko")) return "present";
		if (command.includes("packages.list")) return "MISS com.missing";
		if (command.includes("[ -e ") || command.includes("ls -d ")) return "0=0";
		return "";
	});
	const warning = await moduleApi.preflightConfig(
		{
			paths: [{ path: "/missing", useParent: false, group: "" }],
			scope: "deny",
			allowPackages: new Set(),
			denyPackages: new Set(["com.missing"]),
		},
		{ loaded: false },
		{ requireModule: true, bridge },
	);
	assert.equal(warning.ok, true);
	assert.equal(warning.warnings.length, 2);
	assert.match(warning.warnings.join("\n"), /隐藏路径/);
	assert.match(warning.warnings.join("\n"), /包名/);
});

test("preflightConfig does not stat paths that a loaded global/allow module may hide", async () => {
	const bridge = fakeBridge((command) => {
		if (command.includes("[ -e ") || command.includes("ls -d ")) throw new Error("stat should be skipped");
		return "";
	});
	const result = await moduleApi.preflightConfig(
		{ paths: [{ path: "/hidden", useParent: false, group: "" }], scope: "global", allowPackages: new Set(), denyPackages: new Set() },
		{ loaded: true },
		{ bridge },
	);
	assert.equal(result.ok, true);
	assert.deepEqual(bridge.commands, []);

	const partial = await moduleApi.preflightConfig(
		{
			paths: [
				{ path: "/one", useParent: false, group: "" },
				{ path: "/two", useParent: false, group: "" },
			],
			scope: "global",
			allowPackages: new Set(),
			denyPackages: new Set(),
		},
		{ loaded: true, resolvedCount: 1 },
		{ bridge },
	);
	assert.equal(partial.warnings.length, 1);
	assert.match(partial.warnings[0], /1\/2/);
});

test("probeStatus reports procguard.ko availability and kernel resolved_count", async () => {
	const bridge = fakeBridge((command) => {
		if (command.includes("grep '^pathmask '")) return "pathmask 123 0 - Live 0x0";
		if (command.includes("procguard.ko")) return "missing";
		if (command.includes("resolved_count")) return "3";
		return "";
	});
	const status = await moduleApi.probeStatus({ bridge });
	assert.equal(status.loaded, true);
	assert.equal(status.procguardKo, "missing");
	assert.equal(status.resolvedCount, 3);
});
