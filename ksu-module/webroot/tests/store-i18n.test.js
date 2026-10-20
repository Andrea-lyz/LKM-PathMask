const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore, cloneValue, diffKeys, valuesEqual } = require("../js/core/store.js");
const { applyStaticText, detectUiLang, setLanguageDirect, translate } = require("../js/core/i18n.js");

test("cloneValue copies arrays, sets and nested objects", () => {
	const source = { list: [1, { a: 2 }], set: new Set(["x"]), nested: { ok: true } };
	const copy = cloneValue(source);
	assert.deepEqual(copy, source);
	assert.notEqual(copy.list, source.list);
	assert.notEqual(copy.list[1], source.list[1]);
	assert.notEqual(copy.set, source.set);
	assert.notEqual(copy.nested, source.nested);
});

test("valuesEqual compares sets and nested objects structurally", () => {
	assert.equal(valuesEqual({ a: [1, 2], s: new Set(["a"]) }, { a: [1, 2], s: new Set(["a"]) }), true);
	assert.equal(valuesEqual({ a: [1, 2] }, { a: [2, 1] }), false);
	assert.equal(valuesEqual(new Set(["a", "b"]), new Set(["b", "a"])), true);
	assert.equal(valuesEqual(null, undefined), false);
});

test("diffKeys only reports changed top-level keys", () => {
	const draft = { a: 1, b: { c: 3 }, d: new Set(["x"]) };
	const saved = { a: 1, b: { c: 2 }, d: new Set(["x"]) };
	assert.deepEqual(diffKeys(draft, saved), ["b"]);
});

test("store tracks draft changes, reset and commit", () => {
	const store = createStore({ scope: "deny", paths: [{ path: "/a" }] });
	let notifications = 0;
	const unsubscribe = store.subscribe(() => { notifications += 1; });

	store.setDraft({ scope: "allow" });
	assert.deepEqual(store.getDirtyKeys(), ["scope"]);
	assert.equal(store.isDirty(), true);
	assert.equal(notifications, 1);

	store.setDraft({ scope: "deny" });
	assert.deepEqual(store.getDirtyKeys(), []);
	assert.equal(store.isDirty(), false);

	store.setDraft({ paths: [{ path: "/b" }] });
	store.commit();
	assert.deepEqual(store.getDirtyKeys(), []);
	assert.deepEqual(store.getSaved().paths, [{ path: "/b" }]);

	store.setDraft({ scope: "global" });
	store.resetDraft();
	assert.equal(store.getDraft().scope, "deny");
	assert.equal(store.isDirty(), false);

	const beforeUnsubscribe = notifications;
	unsubscribe();
	store.setDraft({ scope: "allow" });
	assert.ok(beforeUnsubscribe >= 3);
	assert.equal(notifications, beforeUnsubscribe);
});

test("store getSnapshot returns a copy so callers cannot mutate state", () => {
	const store = createStore({ paths: [{ path: "/a" }] });
	const snapshot = store.getSnapshot();
	snapshot.draft.paths[0].path = "/changed";
	assert.equal(store.getDraft().paths[0].path, "/a");
});

test("detectUiLang prefers a valid saved language, then browser tags", () => {
	assert.equal(detectUiLang({ getItem: () => "en", languages: ["zh-CN"] }), "en");
	assert.equal(detectUiLang({ getItem: () => null, languages: ["zh-CN", "en"] }), "zh");
	assert.equal(detectUiLang({ getItem: () => null, languages: ["fr-FR", "en-US"] }), "en");
	assert.equal(detectUiLang({ getItem: () => null, languages: ["fr-FR"] }), "zh");
});

test("translate handles Chinese keys, unknown keys and placeholders", () => {
	assert.equal(translate("en", "全局"), "Global");
	assert.equal(translate("en", "未翻译的键"), "未翻译的键");
	assert.equal(translate("zh", "全局"), "全局");
	assert.equal(translate("en", "Hello {path}", { path: "/dev/x" }), "Hello /dev/x");
	assert.equal(translate("en", "{0} 秒前", [3]), "3s ago");
	assert.equal(translate("en", "已选 {0} 个应用", [3]), "3 app(s) selected");
});

test("applyStaticText keeps the document language in sync", () => {
	const doc = { documentElement: { lang: "" }, querySelectorAll: () => [] };
	setLanguageDirect("en");
	applyStaticText(doc);
	assert.equal(doc.documentElement.lang, "en");
	setLanguageDirect("zh");
	applyStaticText(doc);
	assert.equal(doc.documentElement.lang, "zh-CN");
});
