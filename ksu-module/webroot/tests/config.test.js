const test = require("node:test");
const assert = require("node:assert/strict");

const {
	CONFIG_FILES,
	DEFAULT_CONFIG,
	configFromTexts,
	serializeConfig,
	validateConfig,
} = require("../js/domain/config.js");

test("configFromTexts parses every persisted field", () => {
	const config = configFromTexts({
		targets: " /system_ext/app/SoterService \nany:scene:dir:/dev/???/scene_mode_category\n# comment\n",
		hideDirents: "1\n",
		scope: "allow\n",
		denyPackages: "com.a\ncom.b\n",
		denyUids: "10100\n10101\n",
		allowPackages: "com.ok\n",
		allowUids: "10200\n",
		allowSystemUids: "0\n1000\n",
		waitSeconds: "90\n",
		enableSyscallHooks: "true\n",
		syscallHooks: "statx, openat\nfaccessat2\n",
		autoSceneDebugfs: "yes\n",
		procguard: "1\n",
		writePolicy: "eacces\n",
	});
	assert.deepEqual(config.paths, [
		{ path: "/system_ext/app/SoterService", useParent: false, group: "" },
		{ path: "/dev/???/scene_mode_category", useParent: true, group: "scene" },
	]);
	assert.equal(config.hideDirents, true);
	assert.equal(config.scope, "allow");
	assert.deepEqual([...config.denyPackages], ["com.a", "com.b"]);
	assert.deepEqual(config.denyUids, ["10100", "10101"]);
	assert.deepEqual([...config.allowPackages], ["com.ok"]);
	assert.deepEqual(config.allowUids, ["10200"]);
	assert.deepEqual([...config.allowSystemUids], ["0", "1000"]);
	assert.equal(config.waitSeconds, 90);
	assert.equal(config.syscallEnabled, true);
	assert.deepEqual([...config.syscallHooks], ["statx", "openat", "faccessat2"]);
	assert.equal(config.autoSceneDebugfs, true);
	assert.equal(config.procguard, true);
	assert.equal(config.writePolicy, "eacces");
});

test("configFromTexts uses safe defaults for empty files", () => {
	const config = configFromTexts({});
	assert.equal(config.scope, DEFAULT_CONFIG.scope);
	assert.equal(config.hideDirents, DEFAULT_CONFIG.hideDirents);
	assert.equal(config.procguard, false);
	assert.equal(config.writePolicy, "passthrough");
	assert.equal(config.waitSeconds, 60);
	assert.equal(config.syscallEnabled, true);
	assert.deepEqual([...config.syscallHooks], [...DEFAULT_CONFIG.syscallHooks]);
	assert.equal(config.paths.length, 0);
});

test("serializeConfig round-trips the same file formats", () => {
	const config = configFromTexts({
		targets: "any:scene:dir:/dev/???/scene_mode_category\n/system_ext/app/SoterService\n",
		hideDirents: "0",
		scope: "deny",
		denyPackages: "com.a\ncom.b",
		denyUids: "10100",
		allowPackages: "",
		allowUids: "",
		allowSystemUids: "0,1000",
		waitSeconds: "75",
		enableSyscallHooks: "0",
		syscallHooks: "statx,openat",
		autoSceneDebugfs: "0",
		procguard: "1",
		writePolicy: "enoent",
	});
	const files = serializeConfig(config);
	assert.equal(files[CONFIG_FILES.targets], "any:scene:dir:/dev/???/scene_mode_category\n/system_ext/app/SoterService\n");
	assert.equal(files[CONFIG_FILES.hideDirents], "0\n");
	assert.equal(files[CONFIG_FILES.scope], "deny\n");
	assert.equal(files[CONFIG_FILES.denyPackages], "com.a\ncom.b\n");
	assert.equal(files[CONFIG_FILES.denyUids], "10100\n");
	assert.equal(files[CONFIG_FILES.allowPackages], "");
	assert.equal(files[CONFIG_FILES.allowUids], "");
	assert.equal(files[CONFIG_FILES.allowSystemUids], "0\n1000\n");
	assert.equal(files[CONFIG_FILES.waitSeconds], "75\n");
	assert.equal(files[CONFIG_FILES.enableSyscallHooks], "0\n");
	assert.equal(files[CONFIG_FILES.syscallHooks], "statx,openat\n");
	assert.equal(files[CONFIG_FILES.autoSceneDebugfs], "0\n");
	assert.equal(files[CONFIG_FILES.procguard], "1\n");
	assert.equal(files[CONFIG_FILES.writePolicy], "enoent\n");
});

test("validateConfig rejects relative paths, duplicates, bad groups and UIDs", () => {
	const config = configFromTexts({
		targets: "relative/path\n/a\n/a\nany:bad group:/b\n",
		scope: "deny",
		denyUids: "abc\n10100\n",
		waitSeconds: "601",
	});
	const result = validateConfig(config);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /绝对路径/);
	assert.match(result.errors.join("\n"), /重复/);
	assert.match(result.errors.join("\n"), /组名/);
	assert.match(result.errors.join("\n"), /UID/);
	assert.match(result.errors.join("\n"), /等待秒数/);
});

test("validateConfig accepts a healthy global config with no app list", () => {
	const config = configFromTexts({
		targets: "/system_ext/app/SoterService\n",
		scope: "global",
		waitSeconds: "60",
	});
	const result = validateConfig(config);
	assert.equal(result.ok, true);
	assert.deepEqual(result.errors, []);
});
