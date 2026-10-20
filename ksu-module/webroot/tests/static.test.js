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
	for (const file of ["app.js", "style.css"]) {
		assert.equal(fs.existsSync(path.join(webroot, file)), false, `legacy ${file} still exists`);
	}
});

test("CSS files do not import external assets", () => {
	for (const file of fs.readdirSync(path.join(webroot, "css"))) {
		const css = fs.readFileSync(path.join(webroot, "css", file), "utf8");
		assert.doesNotMatch(css, /@import\s+url\(\s*["']?https?:/i, `${file} imports a remote stylesheet`);
		assert.doesNotMatch(css, /url\(\s*["']?https?:/i, `${file} references a remote asset`);
	}
});

test("index.html local assets exist and IDs are unique", () => {
	const assets = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((match) => match[1]);
	assert.ok(assets.includes("PY_QR.png") === false, "QR image is loaded from the donate sheet");
	assert.ok(assets.length >= 5);
	for (const asset of assets) {
		assert.ok(fs.existsSync(path.join(webroot, asset)), `missing local asset ${asset}`);
	}
	const seen = new Set();
	for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
		assert.equal(seen.has(match[1]), false, `duplicate id ${match[1]}`);
		seen.add(match[1]);
	}
	assert.ok(fs.existsSync(path.join(webroot, "PY_QR.png")), "donate QR image is missing");
});

test("design tokens cover light/dark and keep a color-mix fallback", () => {
	const tokens = fs.readFileSync(path.join(webroot, "css", "tokens.css"), "utf8");
	assert.match(tokens, /--pm-bg:/);
	assert.match(tokens, /prefers-color-scheme:\s*dark/);
	assert.match(tokens, /--pm-bg:\s*#[0-9a-fA-F]{3,8}/);
	const components = fs.readFileSync(path.join(webroot, "css", "components.css"), "utf8");
	assert.match(components, /@supports\s*\(color:\s*color-mix/);
});

test("app icon images overlay the fallback letter instead of sharing its grid", () => {
	const components = fs.readFileSync(path.join(webroot, "css", "components.css"), "utf8");
	assert.match(components, /\.appIcon\s*\{[^}]*position:\s*relative/s);
	assert.match(components, /\.appIcon img\s*\{[^}]*position:\s*absolute/s);
	assert.match(components, /\.appIcon img\s*\{[^}]*inset:\s*0/s);
});

test("UI scale tokens define a readable body size and touch target", () => {
	const tokens = fs.readFileSync(path.join(webroot, "css", "tokens.css"), "utf8");
	assert.match(tokens, /--pm-text-body:\s*16px/);
	assert.match(tokens, /--pm-control:\s*44px/);
	assert.match(tokens, /--pm-app-icon:\s*44px/);
});

test("EN_TEXT only keeps translations referenced by the current UI", () => {
	const i18nPath = path.join(webroot, "js", "core", "i18n.js");
	const i18n = fs.readFileSync(i18nPath, "utf8");
	const sources = [html];
	for (const file of fs.readdirSync(path.join(webroot, "js", "core"))) {
		if (file === "i18n.js" || !file.endsWith(".js")) continue;
		sources.push(fs.readFileSync(path.join(webroot, "js", "core", file), "utf8"));
	}
	for (const dir of ["js/domain", "js/ui"]) {
		const walk = (current) => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".js")) sources.push(fs.readFileSync(full, "utf8"));
			}
		};
		walk(path.join(webroot, dir));
	}
	const source = sources.join("\n");
	const start = i18n.indexOf("const EN_TEXT = {");
	const end = i18n.indexOf("\n};", start);
	assert.ok(start >= 0 && end > start, "EN_TEXT object is missing");
	const keys = [...i18n.slice(start, end).matchAll(/^\t"((?:[^"\\]|\\.)*)"\s*:/gm)]
		.map((match) => JSON.parse(`"${match[1]}"`));
	const unused = keys.filter((key) => !source.includes(key));
	assert.deepEqual(unused, []);
});

test("dark mode large surfaces are pure black and on-colors stay readable", () => {
	const tokens = fs.readFileSync(path.join(webroot, "css", "tokens.css"), "utf8");
	const dark = tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)"));
	for (const token of ["bg", "surface", "surface-2", "surface-3"]) {
		assert.match(dark, new RegExp(`--pm-${token}: #000000`), `${token} is not pure black`);
	}
	for (const token of ["on-danger", "on-warning", "on-success"]) {
		assert.match(tokens, new RegExp(`--pm-${token}:`), `${token} is missing`);
	}
});

test("allow-system UIDs are individually selectable and history keeps the old location", () => {
	assert.equal(countMatches(html, /data-allow-system-uid="(?:0|1000|2000)"/g), 3);
	assert.doesNotMatch(html, /allowSystemUidsInput/);
	const view = fs.readFileSync(path.join(webroot, "js", "ui", "views", "diagnostics.js"), "utf8");
	assert.match(view, /DIAG_HISTORY_DIR = "\/data\/adb\/pathmask\/diag-history"/);
	assert.match(view, /LEGACY_DIAG_HISTORY_DIR = "\/data\/adb\/pathmask\/diagnostics"/);
	assert.match(view, /DIAG_HISTORY_KEEP = 5/);
	const app = fs.readFileSync(path.join(webroot, "js", "ui", "app.js"), "utf8");
	assert.match(app, /BOOT_POLL_INTERVAL_MS = 5000/);
	assert.match(app, /runExclusive/);
});
