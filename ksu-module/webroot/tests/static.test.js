const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webroot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(webroot, "index.html"), "utf8");

function countMatches(source, regex) {
	return [...source.matchAll(regex)].length;
}

test("index.html loads the new styles and scripts in dependency order", () => {
	const css = ["tokens.css", "base.css", "components.css", "views.css"];
	for (const file of css) {
		assert.match(html, new RegExp(`css/${file.replace(".", "\\.")}`), `missing ${file}`);
		assert.ok(fs.existsSync(path.join(webroot, "css", file)), `${file} does not exist`);
	}
	const scripts = [
		"js/core/format.js",
		"js/core/bridge.js",
		"js/domain/apps.js",
		"js/core/store.js",
		"js/core/i18n.js",
		"js/domain/config.js",
		"js/domain/module.js",
		"js/domain/diagnostics.js",
		"js/ui/views/home.js",
		"js/ui/views/targets.js",
		"js/ui/views/diagnostics.js",
		"js/ui/views/settings.js",
		"js/ui/app.js",
	];
	let last = -1;
	for (const file of scripts) {
		const index = html.indexOf(file);
		assert.ok(index > last, `script ${file} missing or out of order`);
		assert.ok(fs.existsSync(path.join(webroot, file)), `${file} does not exist`);
		last = index;
	}
});

test("index.html has four views and four bottom-nav tabs", () => {
	assert.equal(countMatches(html, /data-view="(home|targets|diagnostics|settings)"/g), 4);
	assert.equal(countMatches(html, /role="tab"[^>]*data-tab="(home|targets|diagnostics|settings)"/g), 4);
	assert.match(html, /role="tablist"/);
	assert.match(html, /aria-live="polite"/);
});

test("index.html contains the required interaction anchors", () => {
	for (const id of [
		"statusText",
		"moduleVersion",
		"homeView",
		"targetsView",
		"diagnosticsView",
		"settingsView",
		"statusHero",
		"applyBar",
		"applySummary",
		"applyBtn",
		"saveOnlyBtn",
		"discardBtn",
		"toast",
		"confirmDialog",
		"sheet",
		"pathList",
		"appList",
		"verdictBox",
		"healthList",
		"logOutput",
		"reportOutput",
		"procguardEnableInput",
		"waitSecondsInput",
		"restoreDefaultsBtn",
	]) {
		assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
	}
});

test("index.html has no external assets and no hardcoded version", () => {
	assert.doesNotMatch(html, /<(?:script|img|link)[^>]+(?:src|href)="https?:\/\//i);
	assert.doesNotMatch(html, /v2\.\d+\.\d+/);
	assert.doesNotMatch(html, /style\.css|src="\.\/app\.js"/);
});

test("design tokens cover light/dark and keep a color-mix fallback", () => {
	const tokens = fs.readFileSync(path.join(webroot, "css", "tokens.css"), "utf8");
	assert.match(tokens, /--pm-bg:/);
	assert.match(tokens, /prefers-color-scheme:\s*dark/);
	assert.match(tokens, /--pm-bg:\s*#[0-9a-fA-F]{3,8}/);
	const components = fs.readFileSync(path.join(webroot, "css", "components.css"), "utf8");
	assert.match(components, /@supports\s*\(color:\s*color-mix/);
});
