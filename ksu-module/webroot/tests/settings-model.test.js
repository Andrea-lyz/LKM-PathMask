const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSettingsModel, pauseHiding, restoreDefaults, toggleSyscall } = require("../js/ui/views/settings.js");

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
	assert.equal(model.procguardLabel, "已关闭");
	assert.equal(model.procguardNote, "未启用");
	assert.equal(model.syscallCount, 2);
	assert.equal(model.sceneLabel, "运行中仍启用");
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
	assert.equal(model.sceneLabel, "已关闭");
	assert.match(model.sceneNote, /重启后生效/);
});

function actionApp(confirmAnswer) {
	const calls = [];
	const app = {
		calls,
		i18n: { t: (source) => source },
		confirm: async (options) => {
			calls.push({ type: "confirm", options });
			return confirmAnswer;
		},
		getState() {
			return app.state;
		},
		renderAll: () => calls.push({ type: "renderAll" }),
		refresh: async () => calls.push({ type: "refresh" }),
		toast: (message, kind) => calls.push({ type: "toast", message, kind }),
		state: {
			status: null,
			store: { resetDraft: () => calls.push({ type: "resetDraft" }) },
		},
	};
	return app;
}

test("pause hiding asks for confirmation and does nothing when cancelled", async () => {
	const calls = [];
	globalThis.PathMask.module = {
		pauseHiding: async () => {
			calls.push("pause");
			return { status: { paused: true } };
		},
	};
	const app = actionApp(false);
	await pauseHiding(app);
	assert.match(app.calls[0].options.body, /卸载/);
	assert.deepEqual(calls, []);
	assert.equal(app.state.status, null);
});

test("pause hiding updates status only after confirmation", async () => {
	globalThis.PathMask.module = {
		pauseHiding: async () => ({ status: { paused: true } }),
	};
	const app = actionApp(true);
	await pauseHiding(app);
	assert.equal(app.calls[0].type, "confirm");
	assert.equal(app.state.status.paused, true);
	assert.ok(app.calls.some((entry) => entry.type === "renderAll"));
	assert.ok(app.calls.some((entry) => entry.type === "toast" && entry.message === "已暂停隐藏"));
});

test("restore defaults requires confirmation before writing and refreshing", async () => {
	const writes = [];
	globalThis.PathMask.module = {
		restoreDefaults: async () => writes.push("restore"),
	};
	const cancelled = actionApp(false);
	await restoreDefaults(cancelled);
	assert.deepEqual(writes, []);
	assert.equal(cancelled.calls.some((entry) => entry.type === "resetDraft"), false);

	const accepted = actionApp(true);
	await restoreDefaults(accepted);
	assert.deepEqual(writes, ["restore"]);
	assert.ok(accepted.calls.some((entry) => entry.type === "resetDraft"));
	assert.ok(accepted.calls.some((entry) => entry.type === "refresh"));
});

test("settings model marks a running procguard as pending removal", () => {
	const model = buildSettingsModel(draft({ procguard: false }), {
		procguardLoaded: true,
		scene: { enabled: 0, appliedEnabled: 0, status: "", count: 0, detail: "" },
	}, t);
	assert.equal(model.procguardLabel, "运行中");
	assert.equal(model.procguardNote, "应用并重载后关闭。");
});

test("settings model disables procguard when procguard.ko is missing", () => {
	const model = buildSettingsModel(draft({ procguard: true }), {
		procguardLoaded: false,
		procguardKo: "missing",
		scene: { enabled: 0, appliedEnabled: 0, status: "", count: 0, detail: "" },
	}, t);
	assert.equal(model.procguardUnavailable, true);
	assert.equal(model.procguardLabel, "不可用");
	assert.match(model.procguardNote, /procguard\.ko/);
});
