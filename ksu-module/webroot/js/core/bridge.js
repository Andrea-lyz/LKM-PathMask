/*
 * KernelSU WebUI bridge adapter.
 *
 * Stock KernelSU, WebUI X and the standalone WebUI expose different
 * subsets of window.ksu. Everything here feature-detects first and falls
 * back to the shell API that every implementation provides.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.bridge = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
	"use strict";

	function getKsuBridge(target = root) {
		if (target && target.ksu && typeof target.ksu.exec === "function") return target.ksu;
		return null;
	}

	function detectCapabilities(bridge = getKsuBridge()) {
		const has = (name) => !!(bridge && typeof bridge[name] === "function");
		return {
			exec: has("exec"),
			moduleInfo: has("moduleInfo"),
			listPackages: has("listPackages"),
			getPackagesInfo: has("getPackagesInfo"),
			enableEdgeToEdge: has("enableEdgeToEdge"),
			toast: has("toast"),
		};
	}

	function unavailableError() {
		return new Error("KernelSU WebUI API 不可用");
	}

	function execShell(command, options = {}) {
		const bridge = Object.prototype.hasOwnProperty.call(options, "bridge")
			? options.bridge
			: getKsuBridge();
		const target = options.root || root;
		if (!bridge || typeof bridge.exec !== "function") {
			return Promise.reject(unavailableError());
		}

		return new Promise((resolve, reject) => {
			const callbackName = `pathmask_exec_${Date.now()}_${Math.random().toString(16).slice(2)}`;
			target[callbackName] = (errno, stdout, stderr) => {
				delete target[callbackName];
				if (errno && errno !== 0) {
					const error = new Error(stderr || stdout || `命令失败：${errno}`);
					error.errno = errno;
					error.stderr = stderr || "";
					error.stdout = stdout || "";
					reject(error);
					return;
				}
				resolve(stdout || "");
			};

			const execOptions = {};
			if (options.cwd) execOptions.cwd = options.cwd;
			if (options.env) execOptions.env = options.env;

			try {
				bridge.exec(command, JSON.stringify(execOptions), callbackName);
			} catch (error) {
				try {
					bridge.exec(command, callbackName);
				} catch (fallbackError) {
					delete target[callbackName];
					reject(fallbackError);
				}
			}
		});
	}

	async function safeExec(command, options = {}) {
		try {
			return await execShell(command, options);
		} catch (error) {
			return `ERROR: ${error.message}`;
		}
	}

	async function probeExec(command, options = {}) {
		try {
			const stdout = await execShell(command, options);
			return { ok: true, stdout, errno: 0, stderr: "", error: "" };
		} catch (error) {
			return {
				ok: false,
				stdout: error.stdout || "",
				stderr: error.stderr || "",
				errno: error.errno || 1,
				error: error.message || String(error),
			};
		}
	}

	function getModuleInfo(bridge = getKsuBridge()) {
		if (!bridge || typeof bridge.moduleInfo !== "function") return null;
		try {
			const parsed = JSON.parse(bridge.moduleInfo());
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch (error) {
			return null;
		}
	}

	function listPackages(type = "all", bridge = getKsuBridge()) {
		if (!bridge || typeof bridge.listPackages !== "function") return null;
		try {
			const parsed = JSON.parse(bridge.listPackages(type));
			return Array.isArray(parsed) ? parsed : null;
		} catch (error) {
			return null;
		}
	}

	function getPackagesInfo(packages, bridge = getKsuBridge()) {
		if (!bridge || typeof bridge.getPackagesInfo !== "function") return null;
		try {
			const parsed = JSON.parse(bridge.getPackagesInfo(JSON.stringify(packages)));
			return Array.isArray(parsed) ? parsed : null;
		} catch (error) {
			return null;
		}
	}

	function enableEdgeToEdge(bridge = getKsuBridge()) {
		if (!bridge || typeof bridge.enableEdgeToEdge !== "function") return false;
		try {
			bridge.enableEdgeToEdge(true);
			return true;
		} catch (error) {
			return false;
		}
	}

	function nativeToast(message, bridge = getKsuBridge()) {
		if (!bridge || typeof bridge.toast !== "function") return false;
		try {
			bridge.toast(String(message || ""));
			return true;
		} catch (error) {
			return false;
		}
	}

	return {
		detectCapabilities,
		enableEdgeToEdge,
		execShell,
		getKsuBridge,
		getModuleInfo,
		getPackagesInfo,
		listPackages,
		nativeToast,
		probeExec,
		safeExec,
	};
});
