const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHomeModel } = require("../js/ui/views/home.js");

const t = (source, params) => String(source).replace(/\{(\d+)\}/g, (match, index) => (
	params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
));

function baseDraft(overrides = {}) {
	return {
		scope: "deny",
		paths: [
			{ path: "/system_ext/app/SoterService", useParent: false, group: "" },
			{ path: "/dev/???/scene_mode_category", useParent: true, group: "scene" },
		],
		hideDirents: true,
		procguard: false,
		writePolicy: "passthrough",
		syscallEnabled: true,
		syscallHooks: new Set(["newfstatat", "statx"]),
		autoSceneDebugfs: false,
		waitSeconds: 60,
		allowSystemUids: new Set(["0"]),
		denyPackages: new Set(["com.a", "com.b"]),
		allowPackages: new Set(),
		denyUids: ["10100"],
		allowUids: [],
		...overrides,
	};
}

function baseStatus(overrides = {}) {
	return {
		level: "ok",
		loaded: true,
		waiting: false,
		paused: false,
		failed: false,
		boot: { state: "loaded", updated: 10, deadline: 70, detail: "ok" },
		procguardLoaded: false,
		procguardConf: false,
		...overrides,
	};
}

test("healthy loaded module gets an ok model with path and app counts", () => {
	const model = buildHomeModel({
		draft: baseDraft(),
		status: baseStatus(),
		diagnostics: null,
		validation: { ok: true, errors: [], warnings: [] },
	}, t);
	assert.equal(model.level, "ok");
	assert.equal(model.pathCount, 2);
	assert.equal(model.appCount, 2);
	assert.equal(model.uidCount, 1);
	assert.equal(model.scopeLabel, "黑名单");
	assert.equal(model.guardValue, "关闭");
	assert.equal(model.primaryAction, "diagnose");
	assert.match(model.detail, /模块已加载/);
});

test("boot waiting state becomes a warning with a countdown", () => {
	const model = buildHomeModel({
		draft: baseDraft(),
		status: baseStatus({
			level: "warn",
			loaded: false,
			waiting: true,
			boot: { state: "waiting-targets", updated: 10, deadline: 70, detail: "waiting" },
		}),
		nowEpoch: 40,
		diagnostics: null,
		validation: { ok: true, errors: [], warnings: [] },
	}, t);
	assert.equal(model.level, "warn");
	assert.match(model.title, /等待/);
	assert.match(model.detail, /30/);
	assert.equal(model.primaryAction, "diagnose");
});

test("paused state is informational and offers apply", () => {
	const model = buildHomeModel({
		draft: baseDraft(),
		status: baseStatus({
			level: "info",
			loaded: false,
			paused: true,
			boot: { state: "paused", updated: 10, deadline: 0, detail: "paused" },
		}),
		diagnostics: null,
		validation: { ok: true, errors: [], warnings: [] },
	}, t);
	assert.equal(model.level, "info");
	assert.match(model.title, /暂停/);
	assert.equal(model.primaryAction, "apply");
});

test("dirty draft adds an unsaved issue and an apply action", () => {
	const model = buildHomeModel({
		draft: baseDraft({ scope: "global" }),
		status: baseStatus(),
		diagnostics: null,
		validation: { ok: true, errors: [], warnings: [] },
		dirtyKeys: ["scope"],
	}, t);
	assert.equal(model.dirty, true);
	assert.equal(model.primaryAction, "apply");
	assert.equal(model.issue.title, "有未保存的修改");
	assert.match(model.issue.body, /应用并重载/);
});

test("validation errors outrank status and point at targets", () => {
	const model = buildHomeModel({
		draft: baseDraft({ paths: [{ path: "relative", useParent: false, group: "" }] }),
		status: baseStatus(),
		diagnostics: null,
		validation: { ok: false, errors: ["路径必须是绝对路径：relative"], warnings: [] },
	}, t);
	assert.equal(model.level, "danger");
	assert.equal(model.issue.title, "配置有问题");
	assert.match(model.issue.body, /绝对路径/);
	assert.equal(model.issue.action, "targets");
});

test("diagnostic danger becomes the home verdict", () => {
	const model = buildHomeModel({
		draft: baseDraft(),
		status: baseStatus(),
		diagnostics: {
			level: "danger",
			title: "配置与运行状态不一致",
			detail: "sysfs 参数和 conf 不一致",
			timestamp: 123,
		},
		validation: { ok: true, errors: [], warnings: [] },
	}, t);
	assert.equal(model.level, "danger");
	assert.equal(model.title, "配置与运行状态不一致");
	assert.match(model.detail, /sysfs/);
	assert.equal(model.primaryAction, "diagnose");
});

test("global scope shows every app once instead of a duplicated note", () => {
	const model = buildHomeModel({
		draft: baseDraft({ scope: "global" }),
		status: baseStatus(),
		diagnostics: null,
		validation: { ok: true, errors: [], warnings: [] },
	}, t);
	assert.equal(model.appCount, "∞");
	assert.equal(model.appNote, "全部应用");
	assert.equal(model.uidCount, 0);
});
