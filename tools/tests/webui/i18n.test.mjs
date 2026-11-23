/*
 * Translation coverage for the WebUI.
 *
 * The scheme in app.js uses the Chinese source string as the EN_TEXT
 * lookup key and returns it unchanged on a miss, so an untranslated
 * string is invisible at runtime: English users just see Chinese. This
 * test is what makes that visible. It extracts exactly the strings the
 * runtime will look up -- markup captured through data-i18n*, plus every
 * static t() literal -- and fails on any that EN_TEXT does not cover.
 *
 * It also fails the other way round, on keys whose Chinese source
 * appears nowhere in the shipped files. Those are dead weight, and worse,
 * they are the residue left behind when a call site is rewritten (the
 * global error traps used to translate through t() and left three keys
 * behind when they stopped).
 *
 * Run: node tools/tests/webui/i18n.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { extractEnText, extractTranslateCalls, extractCjkLiterals, enTextSpan } from "./scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webroot = join(here, "..", "..", "..", "ksu-module", "webroot");
const htmlSource = readFileSync(join(webroot, "index.html"), "utf8");
const appSource = readFileSync(join(webroot, "app.js"), "utf8");

const failures = [];
const notes = [];

/*
 * Mirror applyCaptured(): the runtime stores raw.slice(start, end) built
 * from trimStart/trimEnd offsets, which is raw.trim(), and looks *that*
 * up. Whitespace inside the string is part of the key, so a reflow of the
 * markup breaks the lookup silently -- another thing this test catches.
 */
function markupKeys() {
	const { window } = new JSDOM(htmlSource);
	const document = window.document;
	const keys = new Map();   // key -> where it came from

	const add = (value, where) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (!trimmed) return;
		if (!keys.has(trimmed)) keys.set(trimmed, where);
	};

	for (const el of document.querySelectorAll("[data-i18n]")) {
		add(el.textContent, describe(el, "data-i18n"));
	}
	for (const el of document.querySelectorAll("[data-i18n-html]")) {
		add(el.innerHTML, describe(el, "data-i18n-html"));
	}
	for (const el of document.querySelectorAll("[data-i18n-lead]")) {
		// applyCaptured skips elements whose first child is not text.
		const first = el.firstChild;
		if (!first || first.nodeType !== 3) {
			notes.push(`data-i18n-lead on ${describe(el, "data-i18n-lead")} has no leading text node; it will not translate`);
			continue;
		}
		add(first.nodeValue, describe(el, "data-i18n-lead"));
	}
	for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
		for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
			add(el.getAttribute(attr) || "", describe(el, `data-i18n-${attr}`));
		}
	}
	window.close();
	return keys;
}

function describe(el, marker) {
	const id = el.id ? `#${el.id}` : "";
	const cls = el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : "";
	return `${el.tagName.toLowerCase()}${id}${cls} [${marker}]`;
}

const EN_TEXT = extractEnText(appSource);
const enKeys = new Set(Object.keys(EN_TEXT));
const { keys: callKeys, dynamic } = extractTranslateCalls(appSource);
const markup = markupKeys();

/*
 * Keys that deliberately have no EN_TEXT entry. Each one is a template
 * made only of punctuation, digits and placeholders, and every value
 * substituted into it is itself translated at its own call site -- so the
 * rendered line is already correct in both languages and an entry would
 * just be an identity mapping that hides a future gap.
 *
 *   "{0} / 3{1}"        fail count, e.g. "2 / 3 (insmod failed)"
 *   "{0}{1}"            value plus an optional translated qualifier
 *   "  {0} -> {1}"      package -> uid, uid falls back to t("(未解析)")
 *   "procguard.ko: {0}" {0} is t("存在") / t("缺失")
 *   "procguard.conf: {0}"  {0} is t("1（启用）") / t("0（停用）")
 *   "({0})"             parenthesised, {0} is an already-translated reason
 *
 * Listed by hand on purpose: the exemption has to be reviewed to grow.
 */
const NEUTRAL_KEYS = new Set([
	"{0} / 3{1}",
	"{0}{1}",
	"  {0} -> {1}",
	"procguard.ko: {0}",
	"procguard.conf: {0}",
	"({0})",
]);

// --- 1. everything the runtime looks up must be covered -------------------
const lookups = new Map();
for (const [key, where] of markup) lookups.set(key, where);
for (const key of callKeys) {
	if (!lookups.has(key)) lookups.set(key, "app.js t() literal");
}

const missing = [...lookups.keys()].filter((key) => !enKeys.has(key) && !NEUTRAL_KEYS.has(key));
const unlistedNeutral = [...NEUTRAL_KEYS].filter((key) => !lookups.has(key));
if (unlistedNeutral.length) {
	failures.push(`${unlistedNeutral.length} NEUTRAL_KEYS exemption(s) no longer match any call site (remove them):`);
	for (const key of unlistedNeutral) failures.push(`    ${JSON.stringify(key)}`);
}
if (missing.length) {
	failures.push(`${missing.length} string(s) reach t() with no EN_TEXT entry (English users see Chinese):`);
	for (const key of missing) {
		failures.push(`    ${JSON.stringify(key).slice(0, 110)}\n      from: ${lookups.get(key)}`);
	}
}

// --- 2. no key may be unreachable ---------------------------------------
// EN_TEXT's own span is excluded from the literal scan, otherwise every
// key would count as reachable just by being declared.
const reachable = new Set([
	...markup.keys(),
	...callKeys,
	...extractCjkLiterals(appSource, enTextSpan(appSource)),
]);
const dead = [...enKeys].filter((key) => !reachable.has(key));
if (dead.length) {
	failures.push(`${dead.length} EN_TEXT key(s) are dead (their Chinese source appears nowhere in the shipped files):`);
	for (const key of dead) failures.push(`    ${JSON.stringify(key).slice(0, 110)}`);
}

// --- 3. structural checks on the table itself ---------------------------
// A key equal to its own translation is a no-op entry that hides a
// forgotten translation behind an apparent match.
for (const [key, value] of Object.entries(EN_TEXT)) {
	if (key === value) failures.push(`EN_TEXT entry maps to itself (untranslated): ${JSON.stringify(key).slice(0, 90)}`);
}
// Placeholders must survive translation: t() substitutes {0}/{name} after
// the lookup, so a dropped or renumbered placeholder renders literally.
for (const [key, value] of Object.entries(EN_TEXT)) {
	const source = [...key.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(",");
	const target = [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(",");
	if (source !== target) {
		failures.push(`placeholder mismatch in EN_TEXT\n    zh: ${JSON.stringify(key).slice(0, 90)}\n    en: ${JSON.stringify(value).slice(0, 90)}`);
	}
}

console.log(`EN_TEXT entries:      ${enKeys.size}`);
console.log(`markup lookups:       ${markup.size}`);
console.log(`t() literal lookups:  ${callKeys.size}`);
console.log(`t() dynamic calls:    ${dynamic} (resolved from markup or a table at runtime)`);
console.log(`neutral exemptions:   ${NEUTRAL_KEYS.size}`);
for (const note of notes) console.log(`note: ${note}`);

if (failures.length) {
	console.error(`\nFAIL  ksu-module/webroot translation coverage`);
	for (const line of failures) console.error(`  ${line}`);
	process.exit(1);
}
console.log("\nOK    every lookup is translated and every key is reachable");
