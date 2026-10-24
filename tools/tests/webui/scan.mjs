/*
 * Static extraction helpers for the WebUI translation scheme.
 *
 * The whole i18n design in app.js rests on one invariant: the Chinese
 * source string *is* the lookup key, and t() returns it unchanged when
 * EN_TEXT has no entry. That degrades silently -- a missing key shows
 * Chinese in English mode and nothing logs, throws, or fails. These
 * helpers make the invariant checkable in CI.
 *
 * Everything works off a "masked" copy of the source in which strings,
 * template literals, comments and regex literals are replaced by spaces
 * of equal length. Offsets are therefore identical between the masked
 * and the original text, so bracket matching can run on the mask (where
 * a `{` inside a string or a `t(` inside a comment cannot confuse it)
 * while the values are sliced out of the original.
 */

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/*
 * Regex literals have to be told apart from division, because app.js
 * contains /'/g inside shellQuote(). Misreading that one slash makes the
 * scanner treat the quote inside the regex as the start of a string, and
 * everything after it is consumed as string content -- which silently
 * hides almost every real t() call in the file.
 *
 * The usual heuristic applies: a `/` opens a regex when the previous
 * significant character cannot end an expression.
 */
const REGEX_ALLOWED_AFTER = new Set([
	"(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
	"+", "-", "*", "%", "~", "^", "<", ">",
]);
const REGEX_KEYWORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete",
	"void", "case", "do", "else", "yield", "await", "throw",
]);

function lastSignificant(source, i) {
	let j = i - 1;
	while (j >= 0 && /\s/.test(source[j])) j -= 1;
	return j < 0 ? "" : source[j];
}

function lastWord(source, i) {
	let j = i - 1;
	while (j >= 0 && /\s/.test(source[j])) j -= 1;
	const end = j + 1;
	while (j >= 0 && IDENT_CHAR.test(source[j])) j -= 1;
	return source.slice(j + 1, end);
}

function scanQuoted(source, start) {
	const quote = source[start];
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") { i += 2; continue; }
		if (source[i] === quote) return i + 1;
		// A single- or double-quoted literal cannot span lines, so an
		// unterminated one is a scanning mistake rather than a string
		// that runs to the next matching quote somewhere else in the
		// file. Bail at the newline instead of swallowing the rest.
		if (source[i] === "\n") return i;
		i += 1;
	}
	return source.length;
}

function scanRegex(source, start) {
	let i = start + 1;
	let inClass = false;
	while (i < source.length) {
		const c = source[i];
		if (c === "\\") { i += 2; continue; }
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i += 1;
			while (i < source.length && /[a-z]/.test(source[i])) i += 1;
			return i;
		} else if (c === "\n") {
			return start + 1;   // not a regex after all
		}
		i += 1;
	}
	return source.length;
}

function scanTemplate(source, start) {
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") { i += 2; continue; }
		if (source[i] === "`") return i + 1;
		if (source[i] === "$" && source[i + 1] === "{") {
			// The substitution is ordinary code and can itself hold
			// strings, nested templates, comments and regexes, so it
			// gets the same token-aware walk as the top level.
			let depth = 1;
			let j = i + 2;
			while (j < source.length && depth > 0) {
				const token = tokenAt(source, j);
				if (token) { j = token.end; continue; }
				if (source[j] === "{") depth += 1;
				else if (source[j] === "}") depth -= 1;
				j += 1;
			}
			i = j;
			continue;
		}
		i += 1;
	}
	return source.length;
}

/*
 * Classify whatever starts at `i`, or return null for ordinary code.
 * Shared by the top-level walk and by template substitutions so both
 * agree on what a token is.
 */
function tokenAt(source, i) {
	const ch = source[i];
	const next = source[i + 1];
	if (ch === "/" && next === "/") {
		const nl = source.indexOf("\n", i);
		return { end: nl < 0 ? source.length : nl, kind: "comment" };
	}
	if (ch === "/" && next === "*") {
		const close = source.indexOf("*/", i + 2);
		return { end: close < 0 ? source.length : close + 2, kind: "comment" };
	}
	if (ch === '"' || ch === "'") return { end: scanQuoted(source, i), kind: "string" };
	if (ch === "`") return { end: scanTemplate(source, i), kind: "template" };
	if (ch === "/") {
		const prev = lastSignificant(source, i);
		if (prev === "" || REGEX_ALLOWED_AFTER.has(prev) || REGEX_KEYWORDS.has(lastWord(source, i))) {
			const end = scanRegex(source, i);
			if (end > i + 1) return { end, kind: "regex" };
		}
	}
	return null;
}

function evalLiteral(text) {
	try {
		return new Function(`return (${text});`)();
	} catch (error) {
		return undefined;
	}
}

function scanSource(source) {
	const masked = source.split("");
	const literals = [];
	const blank = (from, to) => {
		for (let i = from; i < to && i < masked.length; i += 1) {
			if (masked[i] !== "\n") masked[i] = " ";
		}
	};
	const record = (from, to) => {
		blank(from, to);
		const raw = source.slice(from, to);
		// Templates carrying ${...} cannot be evaluated standalone;
		// they are recorded with value undefined so callers can tell
		// "a literal we could read" from "a literal we could not".
		const value = raw.includes("${") ? undefined : evalLiteral(raw);
		literals.push({ raw, start: from, end: to, value });
	};

	let i = 0;
	while (i < source.length) {
		const token = tokenAt(source, i);
		if (token) {
			if (token.kind === "string" || token.kind === "template") record(i, token.end);
			else blank(i, token.end);
			i = token.end;
			continue;
		}
		i += 1;
	}
	return { masked: masked.join(""), literals };
}

function maskNonCode(source) {
	return scanSource(source).masked;
}

function matchBracket(masked, openIndex) {
	const open = masked[openIndex];
	const close = open === "{" ? "}" : open === "(" ? ")" : "]";
	let depth = 0;
	for (let i = openIndex; i < masked.length; i += 1) {
		if (masked[i] === open) depth += 1;
		else if (masked[i] === close) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/*
 * Offset span of the EN_TEXT object literal, so callers can exclude it
 * from other scans. Without that exclusion a dead-key check is vacuous:
 * every key is a CJK string literal sitting inside EN_TEXT, so every key
 * would look "reachable" by virtue of being declared.
 */
export function enTextSpan(source) {
	const masked = maskNonCode(source);
	const at = masked.indexOf("const EN_TEXT = {");
	if (at < 0) throw new Error("EN_TEXT declaration not found in app.js");
	const open = masked.indexOf("{", at);
	const close = matchBracket(masked, open);
	if (close < 0) throw new Error("EN_TEXT object literal is not balanced");
	return { start: open, end: close + 1 };
}

/*
 * Pull EN_TEXT out of app.js as a real object. Slicing the balanced
 * literal and evaluating it reproduces exactly what the browser parses,
 * escape sequences included, which matters because several keys embed
 * \n and inline <code> markup.
 */
export function extractEnText(source) {
	const { start, end } = enTextSpan(source);
	const value = evalLiteral(source.slice(start, end));
	if (!value || typeof value !== "object") {
		throw new Error("EN_TEXT could not be evaluated");
	}
	return value;
}

/*
 * Every statically knowable t() call site. Returns { keys, dynamic },
 * where `dynamic` counts calls whose first argument is not a literal
 * (applyCaptured's t(record.source), writePolicyLabel's computed key) --
 * those are reachable only through the markup or a lookup table, so they
 * must not be reported as missing.
 */
export function extractTranslateCalls(source) {
	const masked = maskNonCode(source);
	const keys = new Set();
	let dynamic = 0;
	const re = /(^|[^A-Za-z0-9_$.])t\s*\(/g;
	let m;
	while ((m = re.exec(masked)) !== null) {
		const open = masked.indexOf("(", m.index + m[1].length);
		const close = matchBracket(masked, open);
		if (close < 0) continue;
		// First argument: up to the first top-level comma.
		let depth = 0;
		let argEnd = close;
		for (let i = open + 1; i < close; i += 1) {
			const c = masked[i];
			if (c === "(" || c === "[" || c === "{") depth += 1;
			else if (c === ")" || c === "]" || c === "}") depth -= 1;
			else if (c === "," && depth === 0) { argEnd = i; break; }
		}
		const rawArg = source.slice(open + 1, argEnd).trim();
		re.lastIndex = close;
		if (!rawArg) continue;
		// A static literal leaves nothing but spaces in the mask.
		if (masked.slice(open + 1, argEnd).trim() !== "") { dynamic += 1; continue; }
		const value = evalLiteral(rawArg);
		if (typeof value === "string") keys.add(value);
		else dynamic += 1;
	}
	return { keys, dynamic };
}

/*
 * Every string literal in the file that contains CJK, optionally
 * excluding a span. Used as the reachability set for dead-key detection:
 * a translation key whose Chinese source appears nowhere in app.js (outside
 * EN_TEXT itself) and nowhere in index.html can never be looked up, so it
 * is dead. This is deliberately a superset of the t() call sites, because
 * some calls pass a computed key.
 */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function extractCjkLiterals(source, exclude) {
	const found = new Set();
	for (const literal of scanSource(source).literals) {
		if (typeof literal.value !== "string" || !CJK.test(literal.value)) continue;
		if (exclude && literal.start >= exclude.start && literal.end <= exclude.end) continue;
		found.add(literal.value);
	}
	return found;
}

export { maskNonCode, scanSource };
