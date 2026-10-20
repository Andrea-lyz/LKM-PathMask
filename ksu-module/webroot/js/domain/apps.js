/*
 * App-list parsing and filtering.
 *
 * The shell remains the source of truth for which packages exist:
 * `pm list packages -U` works on every manager. KernelSU's
 * getPackagesInfo() is used only to enrich rows with labels and
 * system-app flags, so a missing or restricted bridge degrades to
 * package-name-only rows instead of an empty list.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.apps = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	function parsePackageList(text) {
		const rows = [];
		for (const line of String(text || "").split(/\r?\n/)) {
			const match = line.trim().match(/^package:(.+?)\s+uid:(\d+)$/);
			if (!match) continue;
			rows.push({ pkg: match[1], uid: match[2] });
		}
		return rows;
	}

	function mergePackages(rows, infos) {
		const infoMap = new Map();
		for (const info of Array.isArray(infos) ? infos : []) {
			if (info && info.packageName) infoMap.set(info.packageName, info);
		}
		return rows.map((row) => {
			const info = infoMap.get(row.pkg);
			const resolved = !!info && !info.error;
			return {
				pkg: row.pkg,
				uid: row.uid,
				label: resolved && info.appLabel ? String(info.appLabel) : row.pkg,
				isSystem: resolved ? info.isSystem === true : false,
				resolved,
				icon: resolved ? `ksu://icon/${row.pkg}` : "",
			};
		});
	}

	function filterApps(apps, options = {}) {
		const query = String(options.query || "").trim().toLowerCase();
		const filter = options.filter || "all";
		const selected = options.selected || new Set();
		const result = apps.filter((app) => {
			if (query && !app.pkg.toLowerCase().includes(query) && !app.label.toLowerCase().includes(query)) {
				return false;
			}
			if (filter === "user" && app.isSystem) return false;
			if (filter === "system" && !app.isSystem) return false;
			if (filter === "selected" && !selected.has(app.pkg)) return false;
			return true;
		});
		result.sort((a, b) => {
			const selectedA = selected.has(a.pkg);
			const selectedB = selected.has(b.pkg);
			if (selectedA !== selectedB) return selectedA ? -1 : 1;
			return a.label.localeCompare(b.label) || a.pkg.localeCompare(b.pkg);
		});
		return result;
	}

	function chunks(items, size = 50) {
		const result = [];
		for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
		return result;
	}

	return { chunks, filterApps, mergePackages, parsePackageList };
});
