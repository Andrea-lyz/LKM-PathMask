const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildPathProbeCommand,
	parsePathProbe,
	scopeCopy,
	selectionSummary,
	togglePackageSelection,
	validatePathDraft,
} = require("../js/ui/views/targets.js");

const t = (source, params) => String(source).replace(/\{(\d+)\}/g, (match, index) => (
	params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
));

function draft(overrides = {}) {
	return {
		scope: "deny",
		paths: [{ path: "/a", useParent: false, group: "" }],
		denyPackages: new Set(["com.a", "com.b"]),
		allowPackages: new Set(["com.ok"]),
		denyUids: ["10100", "10101"],
		allowUids: ["10200"],
		...overrides,
	};
}

test("validatePathDraft rejects relative, duplicate and malformed rows", () => {
	assert.deepEqual(validatePathDraft({ path: "", group: "", useParent: false }, [], -1), ["路径不能为空"]);
	assert.match(validatePathDraft({ path: "relative", group: "", useParent: false }, [], -1)[0], /绝对路径/);
	assert.match(validatePathDraft({ path: "/a b", group: "", useParent: false }, [], -1)[0], /空白/);
	assert.match(validatePathDraft({ path: "/a", group: "", useParent: false }, draft().paths, -1)[0], /重复/);
	assert.match(validatePathDraft({ path: "/b", group: "a b", useParent: false }, [], -1)[0], /组名/);
	assert.deepEqual(validatePathDraft({ path: "/b", group: "scene", useParent: true }, draft().paths, -1), []);
});

test("editing a row does not count its old value as a duplicate", () => {
	assert.deepEqual(validatePathDraft({ path: "/a", group: "", useParent: true }, draft().paths, 0), []);
});

test("scopeCopy explains the consequence and changes app titles", () => {
	const globalCopy = scopeCopy("global", t);
	assert.equal(globalCopy.label, "全局");
	assert.match(globalCopy.hint, /所有应用/);
	assert.equal(globalCopy.appTitle, "应用列表");
	const allowCopy = scopeCopy("allow", t);
	assert.equal(allowCopy.label, "白名单");
	assert.match(allowCopy.hint, /选中的应用不受影响/);
	assert.equal(allowCopy.uidLabel, "白名单 UID");
});

test("selectionSummary counts apps and UIDs for the active scope", () => {
	assert.deepEqual(selectionSummary(draft(), "deny", t), {
		scope: "deny",
		appCount: 2,
		uidCount: 2,
		label: "已选 2 个应用 · 2 个 UID",
	});
	assert.deepEqual(selectionSummary(draft(), "allow", t), {
		scope: "allow",
		appCount: 1,
		uidCount: 1,
		label: "已选 1 个应用 · 1 个 UID",
	});
	assert.deepEqual(selectionSummary(draft(), "global", t), {
		scope: "global",
		appCount: 0,
		uidCount: 0,
		label: "全局模式不读取应用列表",
	});
});

test("togglePackageSelection clones the set instead of mutating the draft", () => {
	const original = draft();
	const added = togglePackageSelection(original, "deny", "com.c", true);
	assert.equal(added.denyPackages.has("com.c"), true);
	assert.equal(original.denyPackages.has("com.c"), false);
	assert.notEqual(added.denyPackages, original.denyPackages);

	const removed = togglePackageSelection(original, "deny", "com.a", false);
	assert.equal(removed.denyPackages.has("com.a"), false);
	assert.equal(original.denyPackages.has("com.a"), true);
	assert.equal(togglePackageSelection(original, "deny", "com.a", false).allowPackages.has("com.ok"), true);
});

test("buildPathProbeCommand quotes literals and expands ??? globs", () => {
	const command = buildPathProbeCommand([
		{ path: "/system_ext/app/SoterService", useParent: false, group: "" },
		{ path: "/dev/???/scene_mode_category", useParent: true, group: "scene" },
	]);
	assert.match(command, /\[ -e '\/system_ext\/app\/SoterService' \]/);
	assert.match(command, /ls -d \/dev\/\*\*\*\/scene_mode_category/);
	assert.match(command, /echo "0=1"/);
});

test("parsePathProbe maps shell output back to rows", () => {
	const map = parsePathProbe("0=1\n1=0\n2=unknown\n");
	assert.equal(map.get(0), true);
	assert.equal(map.get(1), false);
	assert.equal(map.get(2), null);
});
