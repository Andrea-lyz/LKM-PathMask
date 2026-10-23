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
import { createKsuStub } from "./ksu-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webroot = join(here, "..", "..", "..", "ksu-module", "webroot");
const HTML = readFileSync(join(webroot, "index.html"), "utf8");
const APP = readFileSync(join(webroot, "app.js"), "utf8");

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
	const thrown = [];
	window.addEventListener("error", (event) => {
		if (event && event.message) thrown.push(String(event.message));
	});
	window.addEventListener("unhandledrejection", (event) => {
		thrown.push(`unhandled rejection: ${event.reason}`);
	});

	const stub = createKsuStub({ window, ...(options.stub || {}) });
	window.ksu = stub.ksu;
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

test("tabs expose tablist semantics and respond to arrow keys", async () => {
	const page = await bootReady(await bootPage());
	try {
		const tablist = page.$('[role="tablist"]');
		assert(tablist, "a role=tablist must exist");
		assertEqual(page.$$(".tab").length, 5, "five tabs");
		for (const tab of page.$$(".tab")) {
			assert(tab.hasAttribute("aria-controls"), `${tab.id} needs aria-controls`);
			assert(page.$(`#${tab.getAttribute("aria-controls")}`), `${tab.id} points at a real panel`);
		}
		// Roving tabindex: exactly one tab is in the tab order.
		assertEqual(page.$$(".tab").filter((t) => t.tabIndex === 0).length, 1, "one tabbable tab");
		assertEqual(page.$("#tab-config").getAttribute("aria-selected"), "true", "initial aria-selected");

		page.$("#tab-config").focus();
		const event = key(page, page.$("#tab-config"), "ArrowRight");
		assert(event.defaultPrevented, "arrow key should be consumed by the tablist");
		assertEqual(page.$("#tab-procguard").getAttribute("aria-selected"), "true", "ArrowRight moves selection");
		assertEqual(page.$("#tab-procguard").tabIndex, 0, "selection follows the tab stop");
		assert(page.$("#procguardPanel").classList.contains("active"), "panel follows selection");
		assert(!page.$("#configPanel").classList.contains("active"), "previous panel deactivated");
		assertEqual(page.document.activeElement, page.$("#tab-procguard"), "focus follows selection");

		key(page, page.$("#tab-procguard"), "End");
		assertEqual(page.$("#tab-report").getAttribute("aria-selected"), "true", "End jumps to the last tab");
		key(page, page.$("#tab-report"), "ArrowRight");
		assertEqual(page.$("#tab-config").getAttribute("aria-selected"), "true", "arrow keys wrap around");
	} finally {
		await settle(page);
		page.close();
	}
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
		page.$('.langOption[data-lang="en"]').click();
		await sleep(30);
		assertEqual(page.document.documentElement.lang, "en", "<html lang> follows the switch");
		assertEqual(page.$("#saveBtn").textContent, "Save config", "static button translated");
		assertEqual(page.$("#moduleState").textContent, "Loaded", "summary card translated");
		assertEqual(page.$("#tab-config").getAttribute("aria-selected"), "true", "tab state survives the switch");
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

test("hide_dirents accepts the same spellings service.sh does", async () => {
	// parseBoolish is what every other boolean conf goes through; the old
	// `(hideText.trim() || "1") !== "0"` read a hand-edited "off" or "no"
	// as enabled while the kernel and service.sh read it as disabled, so
	// the toggle disagreed with the module it was supposed to show.
	const page = await bootReady(await bootPage({
		stub: { conf: { "/data/adb/pathmask/hide_dirents.conf": "off" } },
	}));
	try {
		const { parseBoolish } = page.pm();
		assertEqual(parseBoolish("off", true), false, "'off' means disabled");
		assertEqual(parseBoolish("no", true), false, "'no' means disabled");
		assertEqual(parseBoolish("false", true), false, "'false' means disabled");
		assertEqual(parseBoolish("", true), true, "empty falls back to the default");
		assertEqual(parseBoolish("yes", false), true, "'yes' means enabled");
		assertEqual(parseBoolish("1\n", false), true, "trailing newline tolerated");
		assertEqual(page.$("#hideDirentsInput").checked, false,
			"the toggle must follow a hand-edited 'off', matching what service.sh does");
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
