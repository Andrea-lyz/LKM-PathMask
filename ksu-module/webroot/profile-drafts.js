(() => {
	"use strict";

	const maxProfiles = 1024;
	const maxPaths = 256;
	const maxConfigBytes = 131072;
	const maxUser = 21474;
	const packagePattern = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

	function byteLength(text) {
		let count = 0;
		for (const ch of text) {
			const code = ch.codePointAt(0);
			if (code >= 0xd800 && code <= 0xdfff) return Infinity;
			count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		}
		return count;
	}

	function validPath(path) {
		return typeof path === "string" && path === path.trim() && path.startsWith("/")
			&& !/^\/+$/u.test(path) && path.length <= 255 && !/[,;\x00-\x1f\x7f]/.test(path)
			&& byteLength(path) <= 255;
	}

	function appKey(app) {
		const uid = /^\d+$/.test(app.uid) ? Number(app.uid) : NaN;
		const user = Number.isSafeInteger(uid) ? Math.floor(uid / 100000) : "?";
		return user + ":" + app.pkg;
	}

	const keyOf = row => (row.userId ?? "?") + ":" + row.packageName;
	const record = value => !!value && typeof value === "object" && !Array.isArray(value);
	function cleanProfile(row) {
		if (!record(row) || typeof row.packageName !== "string" || row.packageName.length > 255
			|| !packagePattern.test(row.packageName)
			|| !(row.userId === null || Number.isSafeInteger(row.userId) && row.userId >= 0 && row.userId <= maxUser)
			|| typeof row.enabled !== "boolean" || typeof row.filterDirectory !== "boolean"
			|| !Array.isArray(row.paths) || row.paths.length > maxPaths
			|| !row.paths.every(validPath) || new Set(row.paths).size !== row.paths.length) return null;
		return { packageName: row.packageName, userId: row.userId, enabled: row.enabled,
			filterDirectory: row.filterDirectory, paths: row.paths.slice() };
	}

	function decodeRules(text) {
		if (typeof text !== "string" || text.length > maxConfigBytes || byteLength(text) > maxConfigBytes)
			return null;
		const profiles = new Map();
		let current = null;
		for (const line of text.split(/\r?\n/)) {
			if (/^ *$|^#/.test(line)) continue;
			const header = /^app +(0|[1-9][0-9]*) +([^ ]+) +([01]) +([01]) *$/.exec(line);
			if (header) {
				const profile = cleanProfile({ userId: Number(header[1]), packageName: header[2],
					enabled: header[3] === "1", filterDirectory: header[4] === "1", paths: [] });
				if (!profile || profiles.size >= maxProfiles || profiles.has(keyOf(profile))) return null;
				current = { enabled: profile.enabled, filterDirectory: profile.filterDirectory, paths: [] };
				profiles.set(keyOf(profile), current);
			} else if (line.startsWith("path ") && current) {
				const path = line.slice(5);
				if (!validPath(path) || current.paths.length >= maxPaths || current.paths.includes(path)) return null;
				current.paths.push(path);
			} else return null;
		}
		return profiles;
	}

	function encodeRules(profiles) {
		if (profiles.size > maxProfiles) return null;
		const out = [];
		let pathCount = 0;
		for (const [key, value] of [...profiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
			const match = /^(0|[1-9][0-9]*):(.+)$/.exec(key);
			if (!match) return null;
			const row = cleanProfile({ ...value, userId: Number(match[1]), packageName: match[2] });
			if (!row) return null;
			if (row.enabled) pathCount += row.paths.length;
			if (pathCount > maxPaths) return null;
			out.push("app " + row.userId + " " + row.packageName + " " + Number(row.enabled) + " " + Number(row.filterDirectory));
			for (const path of row.paths) out.push("path " + path);
		}
		const text = out.length ? out.join("\n") + "\n" : "";
		return byteLength(text) <= maxConfigBytes ? { text, pathCount } : null;
	}

	window.PathMaskProfileDrafts = Object.freeze({ validPath, appKey, decodeRules, encodeRules, byteLength, maxPaths, maxConfigBytes });
})();
