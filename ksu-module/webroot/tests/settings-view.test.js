const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSettingsModel, toggleSyscall } = require("../js/ui/views/settings.js");

const t = (source, params) => String(source).replace(/\{(\d+)\}/g, (match, index) => (
	params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
));

function draft(overrides = {}) {
	return {
		procguard: false,
		writePolicy: "passthrough",
		syscallEnabled: true,
		syscallHooks: new Set(["newfstatat", "statx"]),
		autoSceneDebugfs: false,
		waitSeconds: 60,
		...overrides,
	};
}

test("toggleSyscall clones the set and keeps at least one hook", () => {
	const original = draft();
	const added = toggleSyscall(original, "openat", true);
	assert.equal(added.syscallHooks.has("openat"), true);
	assert.equal(original.syscallHooks.has("openat"), false);
	assert.notEqual(added.syscallHooks, original.syscallHooks);

	const removed = toggleSyscall(original, "statx", false);
	assert.equal(removed.syscallHooks.has("statx"), false);
	assert.equal(original.syscallHooks.has("statx"), true);
});

test("settings model describes procguard, syscall and Scene state", () => {
	const model = buildSettingsModel(draft(), {
		procguardLoaded: false,
		scene: { enabled: 1, appliedEnabled: 0, status: "watching", count: 2, detail: "waiting" },
	}, t);
	assert.equal(model.procguardLabel, "关闭");
	assert.equal(model.procguardNote, "未启用");
	assert.equal(model.syscallCount, 2);
	assert.equal(model.sceneLabel, "已启用，运行中未生效");
	assert.match(model.sceneNote, /2/);
	assert.equal(model.waitSeconds, 60);
});

test("settings model reflects running procguard and auto Scene", () => {
	const model = buildSettingsModel(draft({ procguard: true, autoSceneDebugfs: true }), {
		procguardLoaded: true,
		scene: { enabled: 1, appliedEnabled: 1, status: "applied", count: 2, detail: "ok" },
	}, t);
	assert.equal(model.procguardLabel, "开启");
	assert.equal(model.procguardNote, "运行中");
	assert.equal(model.sceneLabel, "已生效");
	assert.match(model.sceneNote, /2/);
});

test("settings model treats unlimited wait and disabled syscall as explicit states", () => {
	const model = buildSettingsModel(draft({ waitSeconds: 600, syscallEnabled: false, syscallHooks: new Set() }), {
		procguardLoaded: false,
		scene: { enabled: 0, appliedEnabled: 0, status: "", count: 0, detail: "" },
	}, t);
	assert.equal(model.syscallCount, 0);
	assert.equal(model.syscallNote, "已关闭");
	assert.equal(model.waitSeconds, 600);
	assert.equal(model.sceneLabel, "关闭");
});
