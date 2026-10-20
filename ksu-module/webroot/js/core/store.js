/*
 * Tiny observable draft/saved store.
 *
 * The WebUI never writes a control's value straight to disk. Controls
 * update a draft; this store compares the draft with the last saved
 * snapshot and tells the apply bar how many top-level fields differ.
 * Sets and arrays are compared structurally, because scope selections
 * and syscall hooks are Sets.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.store = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	function cloneValue(value) {
		if (value instanceof Set) {
			const copy = new Set();
			for (const item of value) copy.add(cloneValue(item));
			return copy;
		}
		if (Array.isArray(value)) return value.map(cloneValue);
		if (value && typeof value === "object") {
			const copy = {};
			for (const key of Object.keys(value)) copy[key] = cloneValue(value[key]);
			return copy;
		}
		return value;
	}

	function valuesEqual(a, b) {
		if (a === b) return true;
		if (a instanceof Set || b instanceof Set) {
			if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
			for (const item of a) if (!b.has(item)) return false;
			return true;
		}
		if (Array.isArray(a) || Array.isArray(b)) {
			if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
			return a.every((item, index) => valuesEqual(item, b[index]));
		}
		if (a && b && typeof a === "object" && typeof b === "object") {
			const aKeys = Object.keys(a);
			const bKeys = Object.keys(b);
			if (aKeys.length !== bKeys.length) return false;
			return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key]));
		}
		return false;
	}

	function diffKeys(draft, saved) {
		const keys = new Set([...Object.keys(draft || {}), ...Object.keys(saved || {})]);
		const result = [];
		for (const key of keys) {
			if (!valuesEqual(draft ? draft[key] : undefined, saved ? saved[key] : undefined)) {
				result.push(key);
			}
		}
		return result;
	}

	function createStore(initial = {}) {
		let saved = cloneValue(initial);
		let draft = cloneValue(initial);
		const listeners = new Set();

		function notify() {
			const snapshot = {
				saved: cloneValue(saved),
				draft: cloneValue(draft),
				dirty: diffKeys(draft, saved),
			};
			for (const listener of listeners) {
				try {
					listener(snapshot);
				} catch (error) {
					// A broken view must not stop the other views from updating.
					if (typeof console !== "undefined" && console.error) console.error(error);
				}
			}
		}

		return {
			getSaved: () => cloneValue(saved),
			getDraft: () => cloneValue(draft),
			getSnapshot: () => ({
				saved: cloneValue(saved),
				draft: cloneValue(draft),
				dirty: diffKeys(draft, saved),
			}),
			getDirtyKeys: () => diffKeys(draft, saved),
			isDirty: () => diffKeys(draft, saved).length > 0,
			setDraft(patch) {
				const next = cloneValue(draft);
				for (const key of Object.keys(patch || {})) next[key] = cloneValue(patch[key]);
				draft = next;
				notify();
			},
			replaceDraft(next) {
				draft = cloneValue(next);
				notify();
			},
			update(mutator) {
				const next = cloneValue(draft);
				const result = mutator(next);
				draft = result === undefined ? next : cloneValue(result);
				notify();
			},
			resetDraft() {
				draft = cloneValue(saved);
				notify();
			},
			commit(next) {
				if (next !== undefined) draft = cloneValue(next);
				saved = cloneValue(draft);
				notify();
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
	}

	return { cloneValue, createStore, diffKeys, valuesEqual };
});
