/*
 * Smoke test for the PathMask WebUI.
 *
 * app.js is ~4000 lines that run once, at page load, against a bridge
 * that only exists inside KernelSU Manager. Nothing else in this repo
 * executes it: a syntax error, a null query selector, a TDZ read in the
 * error trap, or a handler wired to the wrong id all survive review and
 * only show up as a blank or frozen WebUI on a device. This boots the
 * real index.html and the real app.js in jsdom against a stubbed
 * `window.ksu`, then drives the UI the way a user would.
 *
 * Run: node tools/tests/webui/smoke.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { createKsuStub, resolveCommand } from "./ksu-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webroot = join(here, "..", "..", "..", "ksu-module", "webroot");
const HTML = readFileSync(join(webroot, "index.html"), "utf8");
const APP = readFileSync(join(webroot, "app.js"), "utf8");
const GLASS = readFileSync(join(webroot, "liquid-glass.js"), "utf8");
const APP_DIRECTORY = readFileSync(join(webroot, "app-directory.js"), "utf8");
const PROFILE_DRAFTS = readFileSync(join(webroot, "profile-drafts.js"), "utf8");

const results = [];
function test(name, fn) {
	results.push({ name, fn });
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(page, predicate, label, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		let ok = false;
		try {
			ok = !!predicate(page);
		} catch (error) {
			ok = false;
		}
		if (ok) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${label}`);
}

/*
 * Boot the page. `runScripts: "dangerously"` executes the inline error
 * trap in index.html exactly as a WebView would; app.js is then eval'd
 * by hand because jsdom does not fetch the external <script src>.
 * Instrumenting the evaluated source with one extra assignment is what
 * lets a test read module-scope constants that a classic script keeps
 * off `window`.
 */
async function bootPage(options = {}) {
	const dom = new JSDOM(HTML, {
		runScripts: "dangerously",
		url: "https://pathmask.test/",
	});
	const { window } = dom;
	window.TextDecoder = TextDecoder;
	const thrown = [];
	window.addEventListener("error", (event) => {
		if (event && event.message) thrown.push(String(event.message));
	});
	window.addEventListener("unhandledrejection", (event) => {
		thrown.push(`unhandled rejection: ${event.reason}`);
	});

	const stub = createKsuStub({ window, ...(options.stub || {}) });
	window.ksu = stub.ksu;
	if (options.fullScreen) stub.ksu.fullScreen = options.fullScreen;
	window.eval(GLASS);
	if (!options.withoutDraftCodec) window.eval(PROFILE_DRAFTS);
	window.eval(APP_DIRECTORY);
	if (options.execTimeoutMs) window.__pathmaskExecTimeoutMs = options.execTimeoutMs;
	try {
		window.localStorage.setItem("pathmask.uiLang", options.lang || "zh");
	} catch (error) {
		// Without storage the page falls back to navigator language.
	}

	// Instrument the evaluated source so a test can read module-scope
	// bindings that a classic script keeps off `window`. Each getter is
	// individually guarded: a binding that does not exist in the version
	// under test must yield undefined rather than throw at eval time and
	// take every unrelated check down with it.
	const instrumented = `${APP}
;window.__pm = (function() {
	const safe = (f) => function() { try { return f(); } catch (e) { return undefined; } };
	const defs = {
		uiLang: () => uiLang, apps: () => apps, busy: () => busy,
		lastSnapshot: () => lastSnapshot, EXEC_TIMEOUT_MS: () => EXEC_TIMEOUT_MS,
		t: () => t, EN_TEXT: () => EN_TEXT, parseBoolish: () => parseBoolish,
		parseHideDirents: () => parseHideDirents,
	};
	const out = {};
	for (const k of Object.keys(defs)) {
		Object.defineProperty(out, k, { get: safe(defs[k]), enumerable: true });
	}
	return out;
})();
`;
	window.eval(instrumented);

	const page = {
		window,
		document: window.document,
		thrown,
		stub,
		$: (sel) => window.document.querySelector(sel),
		$$: (sel) => [...window.document.querySelectorAll(sel)],
		pm: () => window.__pm,
		close: () => window.close(),
	};
	return page;
}

// Wait for the load-time refreshConfig + automatic diagnostic to finish.
async function bootReady(page, label = "诊断已生成") {
	await waitFor(page, () => page.$("#statusText").textContent === label, `status "${label}"`);
	return page;
}

function fireChange(page, el) {
	el.dispatchEvent(new page.window.Event("change", { bubbles: true }));
}

function key(page, target, name, init = {}) {
	const event = new page.window.KeyboardEvent("keydown", {
		key: name,
		bubbles: true,
		cancelable: true,
		...init,
	});
	target.dispatchEvent(event);
	return event;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/*
 * Drain any in-flight action before tearing the window down. app.js keeps
 * closures over `document` and the module-scope globals; a continuation
 * that resumes after window.close() throws "Cannot read properties of
 * undefined (reading 'createElement')", which aborts the whole run rather
 * than failing the one check that caused it.
 */
async function settle(page) {
	try {
		await waitFor(page, () => page.pm().busy === false, "the page to go idle", 4000);
	} catch (error) {
		// Best effort: a wedged page is the subject of its own check.
	}
	await sleep(30);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
	}
}

/* ------------------------------------------------------------------ */

test("page boots without an error reaching #statusText", async () => {
	const page = await bootReady(await bootPage());
	try {
		const status = page.$("#statusText").textContent;
		assert(!/脚本错误|Script error|Promise 错误|ERROR:/.test(status),
			`status line reports a failure: ${status}`);
		assertEqual(page.thrown.length, 0, `uncaught errors during boot: ${page.thrown.join(" | ")}`);
		assert(page.$("#verdictBox").hidden === false, "verdict box should be revealed after a diagnostic run");
		assert(page.$("#reportOutput").value.includes("PathMask"), "report textarea should be filled in");
	} finally {
		await settle(page);
		page.close();
	}
});

test("config read populates every control from the stubbed device", async () => {
	const page = await bootReady(await bootPage());
	try {
		const rows = page.$$("#pathList .pathRow");
		assertEqual(rows.length, 3, "target_path.conf has three lines");
		assertEqual(rows[0].querySelector('input[type="text"]').value, "/dev/cpuset/scene-daemon", "first path");
		// `dir:/dev/???/...` must split into the Parent toggle plus the bare path.
		assertEqual(rows[1].querySelector('input[type="checkbox"]').checked, true, "dir: prefix sets the Parent toggle");
		assertEqual(rows[1].querySelector('input[type="text"]').value, "/dev/???/scene_mode_category", "dir: prefix stripped from the path field");
		assertEqual(page.$('input[name="scope"][value="deny"]').checked, true, "scope radio");
		assertEqual(page.$("#waitSecondsInput").value, "60", "wait seconds");
		assertEqual(page.$("#hideDirentsInput").checked, true, "hide dirents");
		assertEqual(page.$('#syscallHooksDetails input[data-syscall="faccessat"]').checked, false, "faccessat stays off by default");
		assertEqual(page.$('#syscallHooksDetails input[data-syscall="openat2"]').checked, true, "openat2 on");
		assertEqual(page.$("#moduleState").textContent, "已加载", "module state card");
		assertEqual(page.$("#targetCount").textContent, "3", "resolved target count from sysfs");
		assertEqual(page.$("#uidCount").textContent, "3", "deny UID count from sysfs");
	} finally {
		await settle(page);
		page.close();
	}
});

test("refresh does not leave focus in a path input", async () => {
	const page = await bootReady(await bootPage());
	try {
		// 刷新 rebuilds every path row from disk. addPathRow() used to
		// focus its new input unconditionally, so the last row's text
		// field kept focus -- and on an Android WebView a
		// programmatically focused text input raises the soft keyboard,
		// which is the IME popping open over the hidden-path list.
		page.$("#refreshBtn").click();
		await waitFor(page, () => page.pm().busy === false, "refresh to finish");
		await sleep(20);
		assertEqual(page.$$("#pathList .pathRow").length, 3, "rows rebuilt from the conf");

		const active = page.document.activeElement;
		assert(!(active && active.closest && active.closest("#pathList")),
			`focus must not land inside the path list, got <${active && active.tagName}>`);
		assert(!(active instanceof page.window.HTMLInputElement && active.type === "text"),
			`focus must not land on any text input, that is what raises the IME; got <${active && active.tagName} id=${active && active.id}>`);

		// 添加 must still put the caret in the new empty field.
		const before = page.$$("#pathList .pathRow").length;
		page.$("#addPathBtn").click();
		await sleep(10);
		assertEqual(page.$$("#pathList .pathRow").length, before + 1, "添加 appends a row");
		const added = page.$$("#pathList .pathRow")[before];
		assertEqual(page.document.activeElement, added.querySelector('input[type="text"]'),
			"添加 still focuses the new path field");
	} finally {
		await settle(page);
		page.close();
	}
});

test("settings tabs expose tablist semantics and respond to arrow keys", async () => {
	const page = await bootReady(await bootPage());
	try {
		page.$("#dock-settings").click();
		const tablist = page.$('[role="tablist"]');
		assert(tablist, "a role=tablist must exist");
		assertEqual(page.$$(".tab").length, 5, "five tabs");
		for (const tab of page.$$(".tab")) {
			assert(tab.hasAttribute("aria-controls"), `${tab.id} needs aria-controls`);
			assert(page.$(`#${tab.getAttribute("aria-controls")}`), `${tab.id} points at a real panel`);
		}
		// Roving tabindex: exactly one tab is in the tab order.
		assertEqual(page.$$(".tab").filter((t) => t.tabIndex === 0).length, 1, "one tabbable tab");
		assertEqual(page.$("#tab-general").getAttribute("aria-selected"), "true", "initial aria-selected");

		page.$("#tab-general").focus();
		const event = key(page, page.$("#tab-general"), "ArrowRight");
		assert(event.defaultPrevented, "arrow key should be consumed by the tablist");
		assertEqual(page.$("#tab-procguard").getAttribute("aria-selected"), "true", "ArrowRight moves selection");
		assertEqual(page.$("#tab-procguard").tabIndex, 0, "selection follows the tab stop");
		assert(page.$("#procguardPanel").classList.contains("active"), "panel follows selection");
		assert(!page.$("#generalPanel").classList.contains("active"), "previous panel deactivated");
		assertEqual(page.document.activeElement, page.$("#tab-procguard"), "focus follows selection");

		key(page, page.$("#tab-procguard"), "End");
		assertEqual(page.$("#tab-report").getAttribute("aria-selected"), "true", "End jumps to the last tab");
		key(page, page.$("#tab-report"), "ArrowRight");
		assertEqual(page.$("#tab-general").getAttribute("aria-selected"), "true", "arrow keys wrap around");
	} finally {
		await settle(page);
		page.close();
	}
});

test("home selection shows exactly one mode's configuration without applying it", async () => {
	const page = await bootReady(await bootPage());
	try {
		const choose = mode => {
			page.$("#dock-home").click();
			page.$('#homePanel input[name="scope"][value="' + mode + '"]').click();
			page.$("#dock-apps").click();
		};
		const before = page.stub.calls.length;
		assertEqual(page.$("#dock-apps span").textContent, "配置", "Dock is renamed");
		choose("global");
		assert(page.$("#configPanel").classList.contains("active"), "global opens the shared editor");
		assert(!page.$("#sharedPathPanel").hidden && page.$("#scopeAppPanel").hidden && page.$("#scopeUidPanel").hidden, "global only shows the path card");
		assert(!page.$("#appsPanel").classList.contains("active"), "no directory in global mode");
		choose("allow");
		await waitFor(page, () => page.$$(".allowAppRow").length === 3, "whitelist rows");
		assert(!page.$("#scopeAppPanel").hidden, "whitelist shows the app list");
		assert(page.$("#sharedPathPanel").nextElementSibling === page.$("#scopeAppPanel"), "shared paths precede the list");
		const search = page.$("#searchInput");
		search.value = "10123";
		search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
		assertEqual(page.$$(".allowAppRow").length, 1, "whitelist supports UID search");
		page.$('.allowAppRow [role="switch"]').click();
		assert(page.$("#configPanel").classList.contains("active") && !page.$("#appDetailPanel").classList.contains("active"), "whitelist has no detail page");
		choose("deny");
		await waitFor(page, () => page.$$(".directoryRow").length === 3, "blacklist rows");
		assert(!page.$("#configPanel").classList.contains("active"), "blacklist has no shared path card");
		assert(page.$("#profileModeNotice").hidden === false, "draft application needs an explicit active blacklist");
		page.$(".directoryRow").click();
		assert(page.$("#appDetailPanel").classList.contains("active"), "blacklist opens per-app paths");
		choose("allow");
		assertEqual(page.$("#searchInput").value, "10123", "search retained across switching");
		assert(page.$('.allowAppRow [role="switch"]').checked, "whitelist selection retained");
		assert(!page.stub.calls.slice(before).some(s => s.includes("rmmod") || s.includes(" > '/data/adb/pathmask/")), "selection and navigation do not activate or write any rules");
	} finally { await settle(page); page.close(); }
});

test("explicit mode apply hydrates the saved selection only after a service receipt", async () => {
	const conf = {};
	let accept = false;
	const page = await bootReady(await bootPage({ stub: { conf, respond(command) {
		if (command.includes("/parameters/scope_mode")) return { stdout: conf["/data/adb/pathmask/rule_mode.conf"] || "deny" };
		if (!command.includes('export PATHMASK_RULE_MODE_REQUEST="$mode"')) return undefined;
		if (!accept) return { errno: 32, stderr: "RULE_MODE_UNCONFIRMED" };
		conf["/data/adb/pathmask/rule_mode.conf"] = "global";
		conf["/data/adb/pathmask/boot_state"] = "state=loaded\nrule_mode=global\n";
		return { stdout: "PATHMASK_RULE_MODE_OK global\n" };
	} } }));
	try {
		page.$('#homePanel input[value="global"]').click();
		page.$("#applyRuleModeBtn").click();
		await waitFor(page, () => page.$("#toast").textContent.includes("未能确认模式切换"), "missing receipt shown");
		assertEqual(conf["/data/adb/pathmask/rule_mode.conf"], undefined, "failed apply leaves previous selection");
		accept = true;
		page.$("#applyRuleModeBtn").click();
		await waitFor(page, () => page.$("#ruleModeStatus").textContent.includes("已保存模式：全局"), "receipt updates home");
		const change = page.stub.calls.find(command => command.includes("PATHMASK_RULE_MODE_REQUEST"));
		assert(change.indexOf("grep -Fxq") < change.indexOf('mv "$stage"'), "receipt gates replacing the saved mode");
		assertEqual(page.$("#scopeState").textContent, "全局", "dashboard follows the applied mode");
	} finally { await settle(page); page.close(); }
});

test("same-mode reload reports unconfirmed when startup skips loading", async () => {
	const root = "/data/adb/pathmask/";
	let loaded = true;
	const conf = { [root + "rule_mode.conf"]: "global", [root + "boot_state"]: "state=loaded\nrule_mode=global" };
	const page = await bootReady(await bootPage({ stub: { conf, respond(command) {
		if (command.includes("PATHMASK_REQUIRE_RELOAD_RECEIPT=1")) {
			loaded = false;
			conf[root + "boot_state"] = "state=skipped-targets-missing\nrule_mode=global";
			return { stdout: "" };
		}
		if (command.includes("/parameters/scope_mode")) return { stdout: loaded ? "global" : "" };
		if (!loaded && (command.includes("grep '^pathmask '") || command.includes("cat /proc/modules"))) return { stdout: "" };
	} } }));
	try {
		page.$("#dock-apps").click();
		page.$("#reloadBtn").click();
		await waitFor(page, () => !page.pm().busy && page.$("#toast").textContent.includes("未确认生效"), "unconfirmed reload");
		assertEqual(page.$("#moduleState").textContent, "未加载", "module remains inactive");
	} finally { await settle(page); page.close(); }
});

test("companion activation does not reload an empty blacklist", async () => {
	const root = "/data/adb/pathmask/";
	let companion = false;
	const conf = { [root + "rule_mode.conf"]: "deny", [root + "boot_state"]: "state=skipped-empty-targets\nrule_mode=deny" };
	const page = await bootReady(await bootPage({ stub: { conf, respond(command) {
		if (command.includes("--apply-procguard")) {
			assert(!command.includes("rmmod pathmask"), "companion request does not unload PathMask");
			companion = true;
			return { stdout: "PATHMASK_PROCGUARD_OK enabled\n" };
		}
		if (command.endsWith(" > '/data/adb/pathmask/procguard.conf'")) { conf[root + "procguard.conf"] = "1"; return { stdout: "" }; }
		if (command.includes("grep '^procguard '")) return { stdout: companion ? "procguard 4096 0 - Live" : "" };
		if (command.includes("grep '^pathmask '") || command.includes("cat /proc/modules")) return { stdout: "" };
	} } }));
	try {
		page.$("#dock-settings").click(); page.$("#tab-procguard").click();
		page.$("#procguardEnableInput").click();
		await waitFor(page, () => !page.pm().busy && page.$("#toast").textContent.includes("隔离防护已启用"), "companion receipt");
		assert(companion && page.$("#procguardStats").textContent.includes("已加载"), "the companion is active");
		assertEqual(page.$("#moduleState").textContent, "未加载", "empty PathMask is not reloaded");
	} finally { await settle(page); page.close(); }
});

test("whitelist diagnostics and rows honor the active UID set", async () => {
	const root = "/data/adb/pathmask/";
	const conf = { [root + "scope_mode.conf"]: "deny", [root + "rule_mode.conf"]: "allow", [root + "boot_state"]: "state=loaded\nrule_mode=allow" };
	const page = await bootReady(await bootPage({ stub: { conf, respond(command) {
		if (command.includes("--- basic ---")) return { stdout: resolveCommand(command)
			.replace("scope_mode=deny", "scope_mode=allow").replace("deny_uids=10123,10124,10125", "deny_uids=0,1000,2000") };
		if (command.includes("/parameters/scope_mode")) return { stdout: "allow" };
		if (command.includes("/parameters/deny_uids")) return { stdout: "0,1000,2000" };
	} } }));
	try {
		assert(!page.pm().lastSnapshot.facts.stale.scope && !page.pm().lastSnapshot.facts.stale.denyUids, "a dormant config is not a stale running scope");
		page.$("#dock-apps").click();
		await waitFor(page, () => page.$$(".allowAppRow").length === 3, "manual whitelist");
		page.$("#showSystemInput").click();
		await waitFor(page, () => page.$$(".allowAppRow").length === 5, "system rows");
		const row = page.$$(".allowAppRow").find(r => r.textContent.includes("com.android.settings"));
		assert(!row.querySelector('[role="switch"]').checked, "system app is not manually selected");
		assertEqual(row.querySelector(".runtimeExemption").textContent, "共享路径：运行中已豁免", "actual UID state is displayed");
	} finally { await settle(page); page.close(); }
});

test("blacklist diagnosis uses stored profiles instead of dormant shared paths", async () => {
	const root = "/data/adb/pathmask/";
	const conf = { [root + "rule_mode.conf"]: "deny", [root + "target_path.conf"]: "dormant invalid path", [root + "boot_state"]: "state=loaded\nrule_mode=deny" };
	const page = await bootReady(await bootPage({ stub: { conf, respond(command) {
		if (command.includes("/parameters/app_profiles")) return { stdout: "12345 1" };
		if (command.includes("--check-app-profiles")) return { stdout: "" };
	} } }));
	try {
		assertEqual(page.pm().lastSnapshot.facts.confTargetCount, 0, "dormant paths not counted");
		assertEqual(page.pm().lastSnapshot.facts.appPathCount, 1, "path count comes from the kernel receipt");
		page.$('#homePanel input[value="global"]').click();
		page.$("#dock-settings").click(); page.$("#tab-diagnosis").click(); page.$("#validateConfigBtn").click();
		await waitFor(page, () => !page.pm().busy && page.$("#toast").textContent === "配置校验通过", "stored profile validation");
		assert(page.stub.calls.some(c => c.includes("--check-app-profiles '/data/adb/pathmask/app_profiles.conf'")), "saved mode wins over preview");
	} finally { await settle(page); page.close(); }
});

test("the glass Dock reuses production pages and keeps the current settings subpage", async () => {
	const fullscreen = [];
	const page = await bootReady(await bootPage({ fullScreen: value => fullscreen.push(value) }));
	try {
		assertEqual(fullscreen.join(","), "true", "requests edge-to-edge in KernelSU");
		assert(page.document.documentElement.classList.contains("no-svg-backdrop"), "non-Chromium picks the glass fallback");
		assertEqual(page.$$("#mainDock .liquidDockItem").length, 3, "three real Dock items");
		assertEqual(page.$$("#mainDock .liquidPill").length, 1, "one glass indicator");
		assert(page.$("#homePanel").classList.contains("active"), "home is initial");
		assert(page.$(".actions").hidden, "home hides editing actions");
		page.$("#dock-apps").click();
		assert(page.$("#appsPanel").classList.contains("active"), "apps opens the installed-app directory");
		assert(page.$(".actions").hidden, "directory cannot apply changes");
		page.$("#openLegacyRulesBtn").click();
		assert(page.$("#configPanel").classList.contains("active"), "legacy rules still open the existing configuration");
		assert(!page.$(".actions").hidden, "editing keeps save and reload available");
		page.$("#dock-settings").click();
		assert(page.$("#generalPanel").classList.contains("active"), "settings opens general");
		page.$("#tab-logs").click();
		assertEqual(page.$('#mainDock [aria-current="page"]').id, "dock-settings", "subpage preserves Dock selection");
		page.$("#dock-home").click();
		assert(page.$("#settingsShell").hidden, "leaving settings hides its contents");
		page.$("#dock-settings").click();
		assert(page.$("#logsPanel").classList.contains("active"), "settings returns to the last subpage");
	} finally {
		await settle(page);
		page.close();
	}
});

test("the installed app directory keeps per-app drafts isolated and never applies them", async () => {
	const page = await bootReady(await bootPage());
	try {
		const search = value => {
			const input = page.$("#directorySearch");
			input.value = value;
			input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
		};
		const paths = () => page.$$("#draftPathList code").map(node => node.textContent);
		const add = path => {
			page.$("#draftPathInput").value = path;
			page.$("#draftPathForm").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
		};
		page.$("#dock-apps").click();
		await waitFor(page, () => page.$$(".directoryRow").length === 3, "directory native reader");
		const shellCalls = page.stub.calls.length;
		search("10123");
		assertEqual(page.$$(".directoryRow").length, 1, "search by UID");
		assert(page.$(".directoryRow img").src.startsWith("ksu://icon/"), "use the manager icon URI");
		page.$(".directoryRow").click();
		assert(page.$("#appDetailPanel").classList.contains("active"), "opens app details");
		assert(page.$(".actions").hidden, "legacy application commands remain hidden in the draft editor");
		add("relative");
		assertEqual(page.$("#draftPathInput").getAttribute("aria-invalid"), "true", "refuses relative paths");
		const sample = "/data/local/tmp/draft-<example>";
		add(sample);
		add(sample);
		assertEqual(JSON.stringify(paths()), JSON.stringify([sample]), "retains a single literal path");
		assert(!page.$("#draftPathList example"), "path text is not HTML");
		page.$("#draftEnabled").click();
		page.$("#draftDirectoryFilter").click();
		page.$("#saveAppDraftBtn").click();
		assertEqual(page.$("#draftSaveState").textContent, "已保存草稿（未应用）", "marks the draft accurately");
		page.$("#directoryBackBtn").click();
		assertEqual(page.$("#directorySearch").value, "10123", "return preserves search");
		assert(page.$(".directoryRow .directoryBadge"), "row marks the draft");
		search("10124");
		page.$(".directoryRow").click();
		assertEqual(paths().length, 0, "other app does not inherit a path");
		assert(!page.$("#draftEnabled").checked && !page.$("#draftDirectoryFilter").checked, "other app does not inherit switches");
		page.$("#directoryBackBtn").click();
		search("10123");
		page.$(".directoryRow").click();
		assertEqual(JSON.stringify(paths()), JSON.stringify([sample]), "draft survives page changes");
		assert(page.$("#draftDirectoryFilter").checked, "restores draft feature");
		assertEqual(page.stub.calls.length, shellCalls, "draft flow performs no shell calls");
		page.$("#directoryBackBtn").click();
		search("1000");
		assertEqual(page.$$(".directoryRow").length, 0, "system apps are hidden by default");
		page.$("#directorySystemInput").click();
		await waitFor(page, () => page.$$(".directoryRow").length === 1, "include system apps");
		assertEqual(page.stub.calls.length, shellCalls, "native reader needs no shell fallback");
	} finally {
		await settle(page);
		page.close();
	}
});

test("blacklist omits backup and upgrade controls while keeping legacy settings", async () => {
	const page = await bootReady(await bootPage());
	try {
		const before = page.$$("#pathList .pathRowPath").map(field => field.value).join("\n");
		page.$("#dock-apps").click();
		await waitFor(page, () => page.$$(".directoryRow").length >= 2, "app directory without backup panel");
		assert(!page.$('#appsPanel .directoryCompatibility, #previewLegacyMigrationBtn, #importAppDraftsBtn, #exportAppDraftsBtn'),
			"blacklist does not mount any backup or upgrade controls");
		assert(page.$("#directorySearch") && page.$("#applyProfilesBtn"), "search and applying drafts remain available");
		page.$("#dock-settings").click();
		page.$("#openLegacyRulesBtn").click();
		assert(page.$("#configPanel").classList.contains("active"), "legacy rules remain in Settings");
		assertEqual(page.$$("#pathList .pathRowPath").map(field => field.value).join("\n"), before, "saved legacy paths remain intact");
	} finally {
		await settle(page);
		page.close();
	}
});

test("missing draft assets leave the legacy editor reachable", async () => {
	const page = await bootReady(await bootPage({ withoutDraftCodec: true }));
	try {
		page.$("#dock-apps").click();
		assert(page.$("#configPanel").classList.contains("active"), "old editor is the safe fallback");
		assert(!page.$(".actions").hidden, "old controls remain available");
		assertEqual(page.$("#dock-apps").getAttribute("aria-controls"), "configPanel", "navigation follows fallback panel");
		assertEqual(page.thrown.length, 0, "optional assets did not cause any script error");
	} finally {
		await settle(page);
		page.close();
	}
});

function profileBridge({ initial = null, noReceipt = false } = {}) {
	return {
		conf: { "/data/adb/pathmask/rule_mode.conf": "deny" },
		respond(command) {
			if (command.includes("profile_snapshot || exit 22")) {
				return { stdout: initial === null ? "missing\n" : "a".repeat(64) + "\n" + Buffer.from(initial).toString("base64") };
			}
			if (command.includes("mktemp -d '/data/adb/pathmask/.profile-write.XXXXXX'")) {
				return { stdout: "/data/adb/pathmask/.profile-write.mock00\n" };
			}
			const acknowledgment = /PATHMASK_APP_PROFILES_OK \$request (\d+)/.exec(command);
			if (acknowledgment) {
				return noReceipt ? { errno: 27, stderr: "No kernel confirmation" }
					: { stdout: "PATHMASK_APP_PROFILES_OK 12345 " + acknowledgment[1] + "\n" };
			}
		},
	};
}

async function saveNewProfile(page) {
	page.$("#dock-apps").click();
	await waitFor(page, () => page.$$(".directoryRow").length === 3, "directory");
	page.$(".directoryRow").click();
	const pkg = page.$("#detailAppPackage").textContent;
	const path = "/data/local/tmp/new-profile";
	const input = page.$("#draftPathInput");
	input.value = path;
	page.$("#draftPathForm").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
	page.$("#draftEnabled").click();
	page.$("#draftDirectoryFilter").click();
	page.$("#saveAppDraftBtn").click();
	page.$("#directoryBackBtn").click();
	return { pkg, path };
}

test("confirmed profile changes preserve existing profiles across sessions", async () => {
	const initial = "app 0 luna.safe.luna 1 0\npath /data/local/tmp/existing-profile\n";
	const page = await bootReady(await bootPage({ stub: profileBridge({ initial }) }));
	try {
		page.$("#dock-apps").click();
		await waitFor(page, () => page.$$(".directoryRow").length === 3, "existing profiles loaded");
		page.$(".directoryRow[data-directory-key='0:luna.safe.luna']").click();
		assertEqual(page.$("#draftPathList code").textContent, "/data/local/tmp/existing-profile", "restores existing paths");
		assert(page.$("#draftEnabled").checked, "restores the existing enable switch");
		page.$("#directoryBackBtn").click();
		const { pkg, path } = await saveNewProfile(page);
		const before = page.stub.calls.length;
		page.$("#applyProfilesBtn").click();
		assertEqual(page.stub.calls.length, before, "first click does not touch the device");
		page.$("#applyProfilesBtn").click();
		await waitFor(page, () => page.$("#profileApplyState").textContent.includes("内核已确认 2"), "commit confirmation");
		const writes = page.stub.calls.filter(command => command.includes(">> '/data/adb/pathmask/.profile-write.mock00/candidate'"));
		assert(writes.some(command => command.includes("app 0 " + pkg + " 1 1") && command.includes(path)), "updated app was staged");
		assert(writes.some(command => command.includes("/data/local/tmp/existing-profile")), "unmodified profile was preserved");
		const commit = page.stub.calls.find(command => command.includes("PATHMASK_APP_PROFILES_OK $request"));
		assert(commit.includes("--check-app-profiles") && commit.indexOf("grep -Fxq") < commit.indexOf('mv "$candidate" "$cfg"'), "confirmation gates replacement");
	} finally { await settle(page); page.close(); }
});

test("profile apply fails visibly without a kernel acknowledgment", async () => {
	const page = await bootReady(await bootPage({ stub: profileBridge({ noReceipt: true }) }));
	try {
		await saveNewProfile(page);
		page.$("#applyProfilesBtn").click();
		page.$("#applyProfilesBtn").click();
		await waitFor(page, () => page.$("#profileApplyState").textContent.includes("应用失败"), "reject missing receipt");
		assert(!page.$("#applyProfilesBtn").disabled, "pending edits are retained");
	} finally { await settle(page); page.close(); }
});

test("profile codec rejects ambiguous and overlong paths", async () => {
	const page = await bootReady(await bootPage());
	try {
		const codec = page.window.PathMaskProfileDrafts;
		for (const path of ["/fixture/with,comma", "/fixture/with;semicolon", "/" + "测".repeat(85)]) {
			assert(!codec.validPath(path), "bad path rejected");
			const profile = "app 0 com.example.fixture 1 0\npath " + path + "\n";
			assert(codec.decodeRules(profile) === null, "invalid path in stored rule rejected");
		}
		assert(codec.validPath("/" + "a".repeat(254)), "255 bytes accepted");
		assert(codec.decodeRules("path /fixture") === null, "orphan path is not an empty config");
		const profiles = codec.decodeRules("app 0 com.example.fixture 1 0\npath /fixture/owner\napp 10 com.example.fixture 0 1\npath /fixture/work\n");
		assert(profiles?.has("0:com.example.fixture") && profiles.has("10:com.example.fixture"), "Android users remain distinct");
	} finally { await settle(page); page.close(); }
});

test("log tabs publish their state as toggle buttons", async () => {
	const page = await bootReady(await bootPage());
	try {
		assertEqual(page.$(".logTabs").getAttribute("role"), "group", "log tabs are a group, not a tablist");
		page.$('.logTab[data-log="kernel"]').click();
		assertEqual(page.$('.logTab[data-log="kernel"]').getAttribute("aria-pressed"), "true", "pressed state follows the visible log");
		assertEqual(page.$('.logTab[data-log="status"]').getAttribute("aria-pressed"), "false", "only one log tab is pressed");
		assert(page.$("#logOutput").value.includes("pathmask"), "kernel log rendered into the viewer");
	} finally {
		await settle(page);
		page.close();
	}
});

test("app list uses the native package API and shows app labels", async () => {
	const page = await bootReady(await bootPage());
	try {
		page.$("#loadAppsBtn").click();
		await waitFor(page, () => page.$$("#appList .appRow").length > 0, "app rows");
		assertEqual(page.$$("#appList .appRow").length, 3, "listPackages('user') returns the three user apps");
		const labels = page.$$("#appList .pkgLabel").map((n) => n.textContent);
		assert(labels.includes("Duck Detector"), `app labels should be rendered, got: ${labels.join(", ")}`);
		assert(!page.stub.calls.some((c) => c.startsWith("pm list packages")),
			"the native package API should make the pm subprocess unnecessary");
		assert(page.$("#appListCount").textContent.includes("3"), "result count is announced");

		// 系统应用 must actually reload; it had no listener at all before.
		page.$("#showSystemInput").checked = true;
		fireChange(page, page.$("#showSystemInput"));
		await waitFor(page, () => page.$$("#appList .appRow").length === 5, "system apps included");
		assertEqual(page.$$("#appList .appRow").length, 5, "listPackages('all') adds the two system apps");
	} finally {
		await settle(page);
		page.close();
	}
});

test("ticking an app updates its row in place", async () => {
	const page = await bootReady(await bootPage());
	try {
		page.$("#loadAppsBtn").click();
		await waitFor(page, () => page.$$("#appList .appRow").length > 0, "app rows");
		const before = page.$$("#appList .appRow");
		const target = before[1];
		const box = target.querySelector('input[type="checkbox"]');
		box.checked = true;
		fireChange(page, box);
		await sleep(20);

		const after = page.$$("#appList .appRow");
		assert(after.includes(target), "the row the user ticked must still be the same node (no rebuild)");
		assertEqual(after.indexOf(target), 1, "the row must not be re-sorted away from the pointer");
		assert(target.classList.contains("selected"), "row reflects the new selection");
		assertEqual(before.length, after.length, "no rows added or dropped by a toggle");
		assert(page.pm().lastSnapshot !== undefined, "state still reachable after toggle");
	} finally {
		await settle(page);
		page.close();
	}
});

test("search filters on package name, app label and uid", async () => {
	const page = await bootReady(await bootPage());
	try {
		page.$("#loadAppsBtn").click();
		await waitFor(page, () => page.$$("#appList .appRow").length > 0, "app rows");
		const search = async (term, expected) => {
			page.$("#searchInput").value = term;
			page.$("#searchInput").dispatchEvent(new page.window.Event("input", { bubbles: true }));
			await sleep(20);
			assertEqual(page.$$("#appList .appRow").length, expected, `search "${term}"`);
		};
		await search("duckdetector", 1);
		await search("Luna", 1);          // matches the app label, not the package
		await search("10123", 1);         // matches the uid column
		await search("", 3);
	} finally {
		await settle(page);
		page.close();
	}
});

test("modals trap focus and give it back on close", async () => {
	const page = await bootReady(await bootPage());
	try {
		const donateBtn = page.$("#donateBtn");
		donateBtn.focus();
		donateBtn.click();
		await sleep(20);
		assertEqual(page.$("#donateModal").hidden, false, "donate modal opens");
		assertEqual(page.document.activeElement, page.$('#donateModal [data-modal-close="donateModal"].iconButton'),
			"focus moves into the dialog");

		key(page, page.document.body, "Escape");
		assertEqual(page.$("#donateModal").hidden, true, "Escape closes the modal");
		assertEqual(page.document.activeElement, donateBtn, "focus returns to the control that opened it");

		// The history dialog has several focusable elements, so it can
		// actually exercise the wrap.
		page.$("#historyBtn").click();
		await waitFor(page, () => page.$("#historyModal").hidden === false, "history modal");
		await sleep(20);
		const focusable = page.$$("#historyModal a[href], #historyModal button:not([disabled]), #historyModal textarea:not([disabled]), #historyModal [tabindex]:not([tabindex='-1'])");
		assert(focusable.length >= 3, `expected several focusable elements, found ${focusable.length}`);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		last.focus();
		const forward = key(page, last, "Tab");
		assert(forward.defaultPrevented, "Tab at the end of the dialog is trapped");
		assertEqual(page.document.activeElement, first, "Tab wraps to the first element");
		first.focus();
		const back = key(page, first, "Tab", { shiftKey: true });
		assert(back.defaultPrevented, "Shift+Tab at the start of the dialog is trapped");
		assertEqual(page.document.activeElement, last, "Shift+Tab wraps to the last element");
	} finally {
		await settle(page);
		page.close();
	}
});

test("toast is a live region so feedback is announced", async () => {
	const page = await bootReady(await bootPage());
	try {
		assertEqual(page.$("#toast").getAttribute("role"), "status", "toast role");
		assertEqual(page.$("#toast").getAttribute("aria-live"), "polite", "toast aria-live");
	} finally {
		await settle(page);
		page.close();
	}
});

test("switching language translates markup and already-rendered text", async () => {
	const page = await bootReady(await bootPage());
	try {
		page.$("#dock-settings").click();
		page.$('.langOption[data-lang="en"]').click();
		await sleep(30);
		assertEqual(page.document.documentElement.lang, "en", "<html lang> follows the switch");
		assertEqual(page.$("#saveBtn").textContent, "Save config", "static button translated");
		assertEqual(page.$("#moduleState").textContent, "Loaded", "summary card translated");
		assertEqual(page.$("#tab-general").getAttribute("aria-selected"), "true", "tab state survives the switch");
		// The verdict box is built from JS strings; before the fix it was
		// simply not re-rendered on a language switch.
		assert(/running|PathMask/i.test(page.$("#verdictBox").textContent),
			`verdict should be re-translated, got: ${page.$("#verdictBox").textContent.slice(0, 80)}`);
		assert(!/[一-鿿]/.test(page.$("#verdictBox").textContent),
			"no Chinese left in the verdict box after switching to English");

		// Switching back must restore the original Chinese markup exactly,
		// including the inline <code> inside hints.
		page.$('.langOption[data-lang="zh"]').click();
		await sleep(30);
		assertEqual(page.$("#saveBtn").textContent, "保存配置", "switching back restores Chinese");
		assert(page.$(".switchRow .hint code") !== null, "inline <code> in a hint survives the round trip");
		assertEqual(page.$("#moduleState").textContent, "已加载", "dynamic text restored");
	} finally {
		await settle(page);
		page.close();
	}
});

test("write-policy toast is translated at call time, not frozen at load", async () => {
	const page = await bootReady(await bootPage());
	try {
		// Boot in Chinese, switch to English, then change the policy. The
		// label table used to be built with t() at module scope, so it
		// kept the boot language for the rest of the page's life.
		page.$('.langOption[data-lang="en"]').click();
		await sleep(30);
		// The boot diagnostic leaves its own toast on screen for 4.2s, so
		// waiting for "toast visible" would match the wrong one. Clear it
		// and wait for the action's own message instead.
		page.$("#toast").hidden = true;
		const radio = page.$('input[name="writePolicy"][value="eacces"]');
		radio.checked = true;
		fireChange(page, radio);
		await waitFor(page, () => !page.$("#toast").hidden, "the write-policy toast");
		await waitFor(page, () => page.pm().busy === false, "the reload to finish");
		const toast = page.$("#toast").textContent;
		assert(toast.includes("Pretend it does not exist"),
			`toast should carry the English label, got: ${toast}`);
		assert(!/[一-鿿]/.test(toast), `toast should contain no Chinese, got: ${toast}`);
	} finally {
		await settle(page);
		page.close();
	}
});

test("an unanswered exec times out, releases the busy lock, and recovers", async () => {
	// The bridge callback is the only thing that can settle an exec, so a
	// command the manager never answers used to pin busy=true forever and
	// leave every action button disabled for the life of the page. Wedge
	// a conf read (readFile goes straight through execShell, unlike the
	// safeExec probes which swallow their own failures), then unwedge it
	// and confirm the page still works.
	const page = await bootPage({
		stub: { swallow: "cat '/data/adb/pathmask/target_path.conf'" },
		execTimeoutMs: 40,
	});
	try {
		assertEqual(page.pm().EXEC_TIMEOUT_MS, 40, "the harness override reached app.js");
		await waitFor(page, () => !page.$("#toast").hidden, "the timeout to be reported");
		assert(/超时|timed out/.test(page.$("#toast").textContent),
			`toast should explain the timeout, got: ${page.$("#toast").textContent}`);
		await waitFor(page, () => page.pm().busy === false, "busy to be released");
		for (const sel of ["#refreshBtn", "#saveBtn", "#reloadBtn", "#pauseBtn", "#runDiagnosticBtn"]) {
			assertEqual(page.$(sel).disabled, false, `${sel} must be usable again after a timeout`);
		}
		assertEqual(page.stub.pending.length, 1, "exactly one command was left unanswered");

		// The abandoned command finishes late. The manager calls the
		// callback by name; that must land on a no-op, not raise a
		// ReferenceError that the error trap paints into #statusText.
		const late = page.stub.pending[0];
		assertEqual(typeof page.window[late], "function", "a late callback still has somewhere to land");
		const statusBefore = page.$("#statusText").textContent;
		page.window[late](0, "late output", "");
		assertEqual(page.window[late], undefined, "the no-op removes itself once called");
		assertEqual(page.$("#statusText").textContent, statusBefore, "a late answer must not touch the status line");

		// Unwedge: the same button must now complete normally.
		page.stub.state.swallow = null;
		page.$("#toast").hidden = true;
		page.$("#refreshBtn").click();
		await waitFor(page, () => page.$$("#pathList .pathRow").length === 3, "the page to recover");
		assertEqual(page.pm().busy, false, "not stuck busy after recovery");
	} finally {
		await settle(page);
		page.close();
	}
});

test("the app list falls back to pm when the native API is absent", async () => {
	const page = await bootReady(await bootPage({ stub: { withoutNativePackages: true } }));
	try {
		assertEqual(typeof page.window.ksu.listPackages, "undefined", "stub models an older manager");
		page.$("#loadAppsBtn").click();
		await waitFor(page, () => page.$$("#appList .appRow").length > 0, "app rows via the shell path");
		assert(page.stub.calls.some((c) => c.includes("pm list packages -U -3")),
			"the pm fallback should run");
		assertEqual(page.$$("#appList .pkgLabel").length, 0, "the shell path has no app labels");
	} finally {
		await settle(page);
		page.close();
	}
});

test("hide_dirents shows what service.sh will load the kernel with", async () => {
	// service.sh normalises this flag with `case 0|false|False|no|No) -> 0;
	// *) -> 1`. That is narrower than parseBoolish: "off" still loads with
	// hide_dirents=1. The toggle must show the value the kernel receives,
	// so it follows service.sh rather than the page's generic parser.
	const cases = [
		["0", false], ["false", false], ["False", false], ["no", false], ["No", false],
		["0\r\n", false], ["no\nignored", false],
		["1", true], ["", true], ["off", true], ["OFF", true], ["n", true], ["NO", true],
	];
	const page = await bootReady(await bootPage({
		stub: { conf: { "/data/adb/pathmask/hide_dirents.conf": "off" } },
	}));
	try {
		const { parseHideDirents } = page.pm();
		for (const [text, expected] of cases) {
			assertEqual(parseHideDirents(text), expected, `service.sh reads ${JSON.stringify(text)} as ${expected ? 1 : 0}`);
		}
		assertEqual(page.$("#hideDirentsInput").checked, true,
			"a hand-edited 'off' still loads with hide_dirents=1, so the toggle must stay on");
	} finally {
		await settle(page);
		page.close();
	}
	const offPage = await bootReady(await bootPage({
		stub: { conf: { "/data/adb/pathmask/hide_dirents.conf": "no" } },
	}));
	try {
		assertEqual(offPage.$("#hideDirentsInput").checked, false, "'no' is off in service.sh and in the toggle");
	} finally {
		await settle(offPage);
		offPage.close();
	}
});

test("the system-apps toggle snaps back when another action is running", async () => {
	// runAction() only toasts while busy, but by then the checkbox has
	// already flipped -- leaving it claiming a filter the list was not
	// loaded with.
	const page = await bootReady(await bootPage({ execTimeoutMs: 400 }));
	try {
		// Wedge only after boot, so the refresh below holds the lock.
		page.stub.state.swallow = "cat '/data/adb/pathmask/target_path.conf'";
		const toggle = page.$("#showSystemInput");
		const before = toggle.checked;
		page.$("#refreshBtn").click();
		await waitFor(page, () => page.pm().busy === true, "the refresh to hold the busy lock");
		const callsBefore = page.stub.calls.length;
		toggle.click();
		assertEqual(toggle.checked, before, "the toggle must not change while busy");
		assert(!page.stub.calls.slice(callsBefore).some((c) => c.includes("pm list packages")),
			"no app load while busy");
	} finally {
		await settle(page);
		page.close();
	}
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, fn } of results) {
	try {
		await fn();
		console.log(`  ok    ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`  FAIL  ${name}`);
		console.error(`      ${error.message.split("\n").join("\n      ")}`);
	}
}

console.log(`\n${results.length - failed}/${results.length} WebUI smoke checks passed`);
process.exit(failed === 0 ? 0 : 1);
