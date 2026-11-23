(() => {
	"use strict";

	// This format exchanges WebUI drafts only. It is not a module ruleset.
	const format = "pathmask-profile-drafts";
	const schemaVersion = 2;
	const maxBackupLength = 1024 * 1024;
	const maxProfiles = 1024;
	const maxPaths = 256;
	const packagePattern = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

	function validPath(path) {
		return typeof path === "string" && path === path.trim() && path.startsWith("/")
			&& !/^\/+$/u.test(path) && path.length <= 768 && !/[\x00-\x1f\x7f]/.test(path);
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
			|| !(row.userId === null || Number.isSafeInteger(row.userId) && row.userId >= 0)
			|| typeof row.enabled !== "boolean" || typeof row.filterDirectory !== "boolean"
			|| !Array.isArray(row.paths) || row.paths.length > maxPaths
			|| !row.paths.every(validPath) || new Set(row.paths).size !== row.paths.length) return null;
		return { packageName: row.packageName, userId: row.userId, enabled: row.enabled,
			filterDirectory: row.filterDirectory, paths: row.paths.slice() };
	}

	function decodeBackup(text) {
		if (typeof text !== "string" || text.length > maxBackupLength) return { error: "size" };
		let data;
		try { data = JSON.parse(text); } catch (_) { return { error: "invalid" }; }
		if (!record(data) || data.format !== format) return { error: "invalid" };
		if (data.schemaVersion !== schemaVersion) return { error: "version" };
		if (!Array.isArray(data.profiles) || data.profiles.length > maxProfiles) return { error: "invalid" };
		// Check the entire backup before yielding any draft, including duplicate keys.
		const profiles = new Map();
		for (const row of data.profiles) {
			const cleaned = cleanProfile(row);
			if (!cleaned || profiles.has(keyOf(cleaned))) return { error: "invalid" };
			profiles.set(keyOf(cleaned), {
				enabled: cleaned.enabled, filterDirectory: cleaned.filterDirectory, paths: cleaned.paths,
			});
		}
		return { profiles };
	}

	function encodeBackup(saved) {
		if (saved.size > maxProfiles) return { error: "size" };
		const profiles = [];
		for (const key of [...saved.keys()].sort()) {
			const separator = key.indexOf(":");
			const prefix = key.slice(0, separator);
			const app = saved.get(key);
			const cleaned = cleanProfile({
				packageName: key.slice(separator + 1),
				userId: prefix === "?" ? null : /^\d+$/.test(prefix) ? Number(prefix) : NaN,
				enabled: app.enabled, filterDirectory: app.filterDirectory, paths: app.paths,
			});
			if (!cleaned || keyOf(cleaned) !== key) return { error: "invalid" };
			profiles.push(cleaned);
		}
		const text = JSON.stringify({ format, schemaVersion, profiles }, null, 2);
		return text.length <= maxBackupLength ? { text } : { error: "size" };
	}

	const lines = raw => typeof raw === "string" ? raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")) : [];

	function inspectLegacy(snapshot) {
		const scope = typeof snapshot?.scopeText === "string" ? snapshot.scopeText.trim() : "";
		if (!["deny", "allow", "global"].includes(scope)) return { mode: "unknown" };
		// Preview the on-disk snapshot, not unsaved changes to the old form.
		// No assignments or paths are copied into the draft store.
		const paths = lines(snapshot.targetText);
		return {
			mode: scope,
			paths: paths.length,
			nonLiteralPaths: paths.filter(path => !validPath(path) || /[*?\[\]]/.test(path)).length,
			packages: scope === "global" ? 0 : lines(scope === "allow" ? snapshot.allowPkgText : snapshot.denyPkgText).length,
			uids: scope === "global" ? 0 : lines(scope === "allow" ? snapshot.allowUidText : snapshot.denyUidText).length,
		};
	}

	window.PathMaskProfileDrafts = Object.freeze({ validPath, appKey, encodeBackup, decodeBackup, inspectLegacy, maxPaths });
})();
