/*
 * Pure formatting and parsing helpers shared by the WebUI and Node tests.
 *
 * Loaded as a classic script in the WebUI, where it attaches to
 * window.PathMask.format. Loaded through require() in tests, where it
 * exports the same object. Keeping this file free of DOM and ksu access
 * lets the parsers be tested without a WebView.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.format = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	const LOG_PAGE_LINES = 80;
	const DEFAULT_WAIT_SECONDS = 60;
	const DEFAULT_TARGET_PATHS = [
		"/dev/cpuset/scene-daemon",
		"dir:/dev/???/scene_mode_category",
		"/system_ext/app/SoterService",
	];
	const ALL_SYSCALL_HOOKS = [
		"newfstatat",
		"statx",
		"faccessat",
		"faccessat2",
		"readlinkat",
		"openat",
		"openat2",
	];
	const DEFAULT_SYSCALL_HOOKS = ALL_SYSCALL_HOOKS.filter((name) => name !== "faccessat");
	const SYSCALL_HOOK_SET = new Set(ALL_SYSCALL_HOOKS);
	const DEFAULT_ALLOW_SYSTEM_UIDS = ["0", "1000", "2000"];
	const ALLOW_SYSTEM_UID_SET = new Set(DEFAULT_ALLOW_SYSTEM_UIDS);

	function shellQuote(value) {
		return `'${String(value).replace(/'/g, "'\\''")}'`;
	}

	function linesFromText(text) {
		return String(text || "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
	}

	function firstLine(text) {
		return String(text || "").split(/\r?\n/)[0]?.trim() || "";
	}

	function countCsv(text) {
		return String(text || "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean).length;
	}

	function normalizeScope(value) {
		const scope = String(value || "").trim();
		if (scope === "global" || scope === "deny" || scope === "allow") return scope;
		return "deny";
	}

	function parseBoolish(text, fallback = false) {
		const value = firstLine(text).toLowerCase();
		if (value === "") return fallback;
		if (value === "1" || value === "true" || value === "yes" || value === "on" || value === "y") {
			return true;
		}
		if (value === "0" || value === "false" || value === "no" || value === "off" || value === "n") {
			return false;
		}
		return fallback;
	}

	/*
	 * A target_path.conf line is one of:
	 *   literal:                /system_ext/app/SoterService
	 *   glob (any segment):     /dev/???/scene_mode_category
	 *   dir: prefix:            hide the parent of each match
	 *   any:<group>: prefix:    member of an OR group
	 *
	 * The prefix order is fixed: any:<group>:dir:<path>.
	 */
	function splitTargetLine(raw) {
		let trimmed = String(raw || "").trim();
		let group = "";
		const match = trimmed.match(/^any:([^:]*):(.*)$/);
		if (match) {
			group = match[1];
			trimmed = match[2].trim();
		}
		let useParent = false;
		if (trimmed.startsWith("dir:")) {
			useParent = true;
			trimmed = trimmed.slice(4).trim();
		}
		return { group, useParent, path: trimmed };
	}

	function joinTargetLine(path, useParent, group) {
		const cleanPath = String(path || "").trim();
		if (!cleanPath) return "";
		let out = useParent ? `dir:${cleanPath}` : cleanPath;
		const cleanGroup = String(group || "").trim();
		if (cleanGroup) out = `any:${cleanGroup}:${out}`;
		return out;
	}

	function parsePackageLine(line) {
		const match = String(line || "").match(/^package:(.+?)\s+uid:(\d+)$/);
		if (!match) return null;
		return { pkg: match[1], uid: match[2] };
	}

	function parseBootState(text) {
		const out = { state: "", updated: 0, deadline: 0, detail: "" };
		if (!text) return out;
		for (const rawLine of String(text).split(/\r?\n/)) {
			const line = rawLine.trim();
			const idx = line.indexOf("=");
			if (idx <= 0) continue;
			const key = line.slice(0, idx);
			const value = line.slice(idx + 1);
			if (key === "state") out.state = value;
			else if (key === "updated") out.updated = Number.parseInt(value, 10) || 0;
			else if (key === "deadline") out.deadline = Number.parseInt(value, 10) || 0;
			else if (key === "detail") out.detail = value;
		}
		return out;
	}

	function parseSceneDebugfsState(text) {
		const out = {
			enabled: 0,
			appliedEnabled: 0,
			status: "",
			packageStatus: "",
			count: 0,
			updated: 0,
			detail: "",
		};
		for (const rawLine of String(text || "").split(/\r?\n/)) {
			const line = rawLine.trim();
			const idx = line.indexOf("=");
			if (idx <= 0) continue;
			const key = line.slice(0, idx);
			const value = line.slice(idx + 1);
			if (key === "enabled") out.enabled = Number.parseInt(value, 10) || 0;
			else if (key === "applied_enabled") out.appliedEnabled = Number.parseInt(value, 10) || 0;
			else if (key === "status") out.status = value;
			else if (key === "package_status") out.packageStatus = value;
			else if (key === "count") out.count = Number.parseInt(value, 10) || 0;
			else if (key === "updated") out.updated = Number.parseInt(value, 10) || 0;
			else if (key === "detail") out.detail = value;
		}
		return out;
	}

	function parseSyscallHooksText(text) {
		const enabled = new Set();
		let anyToken = false;
		for (const token of String(text || "").split(/[\s,]+/)) {
			const name = token.trim();
			if (!name || name.startsWith("#")) continue;
			anyToken = true;
			if (name === "all") {
				for (const hook of ALL_SYSCALL_HOOKS) enabled.add(hook);
				continue;
			}
			if (name === "none") {
				enabled.clear();
				continue;
			}
			if (SYSCALL_HOOK_SET.has(name)) enabled.add(name);
		}
		if (!anyToken) return new Set(DEFAULT_SYSCALL_HOOKS);
		return enabled;
	}

	function parseAllowSystemUidsText(text) {
		const enabled = new Set();
		for (const token of String(text || "").split(/[\s,]+/)) {
			const uid = token.trim();
			if (!uid || uid.startsWith("#")) continue;
			if (ALLOW_SYSTEM_UID_SET.has(uid)) enabled.add(uid);
		}
		return enabled;
	}

	function parseWaitSeconds(text) {
		const value = Number.parseInt(firstLine(text), 10);
		if (Number.isFinite(value) && value > 0) return value;
		return DEFAULT_WAIT_SECONDS;
	}

	function paginate(text) {
		const lines = String(text || "").split(/\r?\n/);
		const pages = [];
		for (let i = 0; i < lines.length; i += LOG_PAGE_LINES) {
			pages.push(lines.slice(i, i + LOG_PAGE_LINES).join("\n"));
		}
		return pages.length ? pages : [""];
	}

	return {
		ALLOW_SYSTEM_UID_SET,
		ALL_SYSCALL_HOOKS,
		DEFAULT_ALLOW_SYSTEM_UIDS,
		DEFAULT_SYSCALL_HOOKS,
		DEFAULT_TARGET_PATHS,
		DEFAULT_WAIT_SECONDS,
		LOG_PAGE_LINES,
		countCsv,
		firstLine,
		joinTargetLine,
		linesFromText,
		normalizeScope,
		paginate,
		parseAllowSystemUidsText,
		parseBoolish,
		parseBootState,
		parsePackageLine,
		parseSceneDebugfsState,
		parseSyscallHooksText,
		parseWaitSeconds,
		shellQuote,
		splitTargetLine,
	};
});
