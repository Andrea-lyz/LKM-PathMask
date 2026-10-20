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
