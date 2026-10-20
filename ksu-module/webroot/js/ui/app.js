/*
 * WebUI bootstrap, router and shared interaction layer.
 *
 * Views are deliberately dumb: they render from app.getDraft() and call
 * app.setDraft() / app.navigate(). The apply bar is the only place that
 * writes to disk, which keeps every control's side effect predictable.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.ui = root.PathMask.ui || {};
		root.PathMask.ui.app = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
	"use strict";

	const format = root.PathMask.format;
	const bridge = root.PathMask.bridge;
	const storeApi = root.PathMask.store;
	const i18n = root.PathMask.i18n;

	const state = {
		view: "home",
		targetsTab: "paths",
		diagTab: "verdict",
		appFilter: "all",
		appQuery: "",
		busy: false,
		moduleInfo: null,
		status: null,
		apps: [],
		appsLoaded: false,
		appsLoading: false,
		diagnostics: null,
		logs: { status: "", config: "", kernel: "", script: "" },
		logTab: "status",
		logPage: 0,
		logWrap: true,
		validation: { ok: true, errors: [], warnings: [] },
		pathStatus: null,
		pathProbing: false,
		pathProbeSignature: "",
		pathProbeHidden: false,
		pathResolvedCount: -1,
	};

	const BOOT_POLL_INTERVAL_MS = 5000;
	const BOOT_WAITING_STATES = new Set(["init", "waiting-targets", "waiting-packages"]);
	const SCENE_WAITING_STATES = new Set(["late-watching", "late-found-pending", "late-reload-retry"]);

	let store = null;
	let confirmResolver = null;
	let sheetSaveHandler = null;
	let toastTimer = null;
	let bootPollHandle = null;
	const dom = {};

	function $(selector, scope = document) {
		return scope.querySelector(selector);
	}

	function $$(selector, scope = document) {
		return [...scope.querySelectorAll(selector)];
	}

	function cacheDom() {
		for (const id of [
			"statusText", "moduleVersion", "aboutVersion", "refreshBtn",
			"homeView", "targetsView", "diagnosticsView", "settingsView",
			"applyBar", "applySummary", "applyBtn", "saveOnlyBtn", "discardBtn",
			"toast", "confirmDialog", "confirmTitle", "confirmBody", "confirmOk", "confirmCancel",
			"sheet", "sheetTitle", "sheetBody", "sheetActions", "sheetCancel", "sheetSave",
			"main", "logWrapInput",
		]) {
			dom[id] = document.getElementById(id);
		}
	}

	function init() {
		cacheDom();
		if (!dom.main || !dom.applyBar) return;
		bridge.enableEdgeToEdge();
		state.moduleInfo = bridge.getModuleInfo();
		i18n.setLanguageDirect(i18n.detectUiLang());
		i18n.applyStaticText(document);
		bindShell();
		bindLanguage();
		updateVersion();
		state.store = storeApi.createStore({});
		store = state.store;
		store.subscribe(onStoreChanged);
		loadInitial();
	}

	function versionLabel(version) {
		const text = String(version || "").trim();
		if (!text) return "—";
		return /^v/i.test(text) ? text : `v${text}`;
	}

	function updateVersion() {
		let version = state.moduleInfo && state.moduleInfo.version ? String(state.moduleInfo.version) : "";
		if (dom.moduleVersion) dom.moduleVersion.textContent = versionLabel(version);
		if (dom.aboutVersion) dom.aboutVersion.textContent = versionLabel(version);
		if (version) return;
		bridge.execShell("grep '^version=' /data/adb/modules/pathmask/module.prop 2>/dev/null | head -n1 || true")
			.then((line) => {
				const match = String(line || "").match(/=\s*(.+)/);
				if (!match) return;
				version = match[1].trim();
				if (dom.moduleVersion) dom.moduleVersion.textContent = versionLabel(version);
				if (dom.aboutVersion) dom.aboutVersion.textContent = versionLabel(version);
			})
			.catch(() => {});
	}

	async function loadInitial() {
		setHeaderStatus(i18n.t("正在读取配置..."));
		try {
			const [configResult, status] = await Promise.all([
				root.PathMask.config.readConfig(),
				root.PathMask.module.probeStatus(),
			]);
			applyLoadedData(configResult, status);
			renderAll();
			refreshPathProbe(true);
			scheduleBootPolling();
			if (!statusWaiting(status)) {
				refreshDiagnostics({ silent: true, saveHistory: false }).catch(() => {});
			}
		} catch (error) {
			state.status = {
				...state.status,
				level: "danger",
				loaded: false,
				error: error.message,
			};
			setHeaderStatus(error.message || i18n.t("读取失败"));
			renderAll();
			toast(error.message || i18n.t("读取失败"), "danger");
		}
	}

	function applyLoadedData(configResult, status) {
		state.status = status;
		state.validation = root.PathMask.config.validateConfig(configResult.config, i18n.t);
		store.replaceDraft(configResult.config);
		store.commit(configResult.config);
		updateHeader();
	}

	function onStoreChanged(snapshot) {
		updateApplyBar(snapshot);
		state.validation = root.PathMask.config.validateConfig(snapshot.draft, i18n.t);
	}

	function updateApplyBar(snapshot) {
		if (!dom.applyBar) return;
		const current = snapshot || (store ? store.getSnapshot() : { dirty: [] });
		const count = current.dirty.length;
		if (!count) {
			dom.applyBar.hidden = true;
			dom.main.classList.remove("hasApplyBar");
			return;
		}
		dom.applyBar.hidden = false;
		dom.main.classList.add("hasApplyBar");
		dom.applySummary.textContent = i18n.t("{0} 项未保存", [count]);
	}

	function updateHeader() {
		const status = state.status || {};
		let label = i18n.t("未加载");
		if (status.loaded) label = i18n.t("已加载");
		else if (status.waiting) label = i18n.t("开机等待中");
		else if (status.paused) label = i18n.t("已暂停");
		else if (status.error) label = status.error;
		setHeaderStatus(label);
	}

	function setHeaderStatus(text) {
		if (dom.statusText) dom.statusText.textContent = text;
	}

	function statusWaiting(status = state.status || {}) {
		const boot = status.boot || {};
		const scene = status.scene || {};
		return BOOT_WAITING_STATES.has(boot.state) || SCENE_WAITING_STATES.has(scene.status);
	}

	function stopBootPolling() {
		if (bootPollHandle) {
			window.clearInterval(bootPollHandle);
			bootPollHandle = null;
		}
	}

	async function refreshDiagnostics(options = {}) {
		const view = root.PathMask.views && root.PathMask.views.diagnostics;
		if (!view || typeof view.run !== "function") return;
		// A page-load or polling diagnosis may still be in flight. Wait for
		// it instead of letting a stale snapshot overwrite the post-apply one.
		for (let wait = 0; state.diagnosing && wait < 100; wait += 1) {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		}
		await view.run(app, options);
	}

	function refreshPathProbe(force = false) {
		const view = root.PathMask.views && root.PathMask.views.targets;
		if (view && typeof view.refreshProbe === "function") view.refreshProbe(app, force);
	}

	function scheduleBootPolling() {
		const status = state.status || {};
		if (!statusWaiting(status)) {
			stopBootPolling();
			return;
		}
		if (bootPollHandle) return;
		bootPollHandle = window.setInterval(async () => {
			if (state.busy) return;
			const wasWaiting = statusWaiting(state.status || {});
			try {
				const next = await root.PathMask.module.probeStatus();
				state.status = next;
				updateHeader();
				renderAll();
				refreshPathProbe(true);
				if (!statusWaiting(next)) {
					stopBootPolling();
					if (wasWaiting) await refreshDiagnostics({ silent: true, saveHistory: false });
				}
			} catch (error) {
				// Polling is best-effort; leave the last known state visible.
			}
		}, BOOT_POLL_INTERVAL_MS);
	}

	function setBusy(nextBusy, message) {
		state.busy = nextBusy;
		for (const button of $$("button")) {
			if (button.closest("#confirmDialog, #sheet")) continue;
			button.disabled = nextBusy;
		}
		for (const control of $$("input, textarea, select")) {
			if (control.closest("#confirmDialog, #sheet")) continue;
			if (nextBusy) {
				if (control.dataset.busyWasDisabled === undefined) {
					control.dataset.busyWasDisabled = control.disabled ? "1" : "0";
				}
				control.disabled = true;
			} else if (control.dataset.busyWasDisabled !== undefined) {
				control.disabled = control.dataset.busyWasDisabled === "1";
				delete control.dataset.busyWasDisabled;
			}
		}
		if (message) setHeaderStatus(message);
		if (!nextBusy) renderAll();
	}

	async function runExclusive(message, action) {
		if (state.busy) {
			toast(i18n.t("正在处理，请稍等"));
			return undefined;
		}
		setBusy(true, message);
		try {
			return await action();
		} finally {
			setBusy(false);
			updateHeader();
		}
	}

	function getDraft() {
		return store ? store.getDraft() : null;
	}

	function setDraft(patch) {
		if (store) store.setDraft(patch);
	}

	function updateDraft(mutator) {
		if (store) store.update(mutator);
	}

	function getState() {
		return state;
	}

	const TABS = {
		view: {
			stateKey: "view",
			values: ["home", "targets", "diagnostics", "settings"],
			paneSelector: ".view[data-view]",
			paneValue: (pane) => pane.dataset.view,
			buttonSelector: ".navItem[data-tab]",
			buttonValue: (button) => button.dataset.tab,
			renderView: (value) => value,
		},
		targetsTab: {
			stateKey: "targetsTab",
			values: ["paths", "scope", "apps"],
			paneSelector: "#targetsView .targetsPane",
			paneValue: (pane) => pane.id.replace(/Section$/, ""),
			buttonSelector: "#targetsSegments [data-targets-tab]",
			buttonValue: (button) => button.dataset.targetsTab,
			renderView: () => "targets",
		},
		diagTab: {
			stateKey: "diagTab",
			values: ["verdict", "logs", "report"],
			paneSelector: "#diagnosticsView .diagPane",
			paneValue: (pane) => pane.id.replace(/Section$/, ""),
			buttonSelector: "#diagSegments [data-diag-tab]",
			buttonValue: (button) => button.dataset.diagTab,
			renderView: () => "diagnostics",
		},
		logTab: {
			stateKey: "logTab",
			values: ["status", "config", "kernel", "script"],
			paneSelector: "",
			buttonSelector: "#logTabs [data-log]",
			buttonValue: (button) => button.dataset.log,
			renderView: () => "diagnostics",
		},
	};

	function selectTab(kind, value) {
		const tab = TABS[kind];
		if (!tab || !tab.values.includes(value)) return false;
		state[tab.stateKey] = value;
		if (tab.paneSelector) {
			for (const pane of $$(tab.paneSelector)) {
				pane.hidden = tab.paneValue(pane) !== value;
			}
		}
		for (const button of $$(tab.buttonSelector)) {
			const active = tab.buttonValue(button) === value;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		renderView(tab.renderView(value));
		return true;
	}

	function navigate(view) {
		if (!selectTab("view", view)) return;
		window.scrollTo({ top: 0, behavior: "smooth" });
	}

	function setTargetsTab(tab) {
		selectTab("targetsTab", tab);
	}

	function setDiagTab(tab) {
		selectTab("diagTab", tab);
	}

	function setLogTab(tab) {
		if (!TABS.logTab.values.includes(tab)) return;
		state.logPage = 0;
		selectTab("logTab", tab);
	}

	function renderAll() {
		for (const view of ["home", "targets", "diagnostics", "settings"]) renderView(view);
		updateHeader();
		updateApplyBar();
	}

	function renderView(view) {
		const module = root.PathMask.views && root.PathMask.views[view];
		if (!module || typeof module.render !== "function") return;
		try {
			module.render(app);
		} catch (error) {
			if (root.console && root.console.error) root.console.error(error);
			toast(error.message || String(error), "danger");
		}
	}

	function bindShell() {
		for (const button of $$(".navItem[data-tab]")) {
			button.addEventListener("click", () => navigate(button.dataset.tab));
		}
		for (const button of $$("#targetsSegments [data-targets-tab]")) {
			button.addEventListener("click", () => setTargetsTab(button.dataset.targetsTab));
		}
		for (const button of $$("#diagSegments [data-diag-tab]")) {
			button.addEventListener("click", () => setDiagTab(button.dataset.diagTab));
		}
		for (const button of $$("#logTabs [data-log]")) {
			button.addEventListener("click", () => setLogTab(button.dataset.log));
		}
		dom.refreshBtn && dom.refreshBtn.addEventListener("click", () => refresh());
		dom.applyBtn && dom.applyBtn.addEventListener("click", () => applyChanges(true));
		dom.saveOnlyBtn && dom.saveOnlyBtn.addEventListener("click", () => applyChanges(false));
		dom.discardBtn && dom.discardBtn.addEventListener("click", discardChanges);
		dom.logWrapInput && dom.logWrapInput.addEventListener("change", () => {
			state.logWrap = dom.logWrapInput.checked;
			const box = $(".logBox");
			if (box) box.classList.toggle("wrap", state.logWrap);
		});
		dom.confirmOk && dom.confirmOk.addEventListener("click", () => closeConfirm(true));
		dom.confirmCancel && dom.confirmCancel.addEventListener("click", () => closeConfirm(false));
		dom.confirmDialog && dom.confirmDialog.addEventListener("click", (event) => {
			if (event.target === dom.confirmDialog || event.target.dataset.dialogClose) closeConfirm(false);
		});
		dom.sheetCancel && dom.sheetCancel.addEventListener("click", closeSheet);
		dom.sheet && dom.sheet.addEventListener("click", (event) => {
			if (event.target === dom.sheet || event.target.dataset.sheetClose !== undefined) closeSheet();
		});
		dom.sheetSave && dom.sheetSave.addEventListener("click", async () => {
			if (!sheetSaveHandler) return;
			const result = await sheetSaveHandler();
			if (result !== false) closeSheet();
		});
		document.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			if (!dom.confirmDialog.hidden) closeConfirm(false);
			else if (!dom.sheet.hidden) closeSheet();
		});
	}

	function bindLanguage() {
		for (const button of $$(".langOption")) {
			button.addEventListener("click", () => {
				const lang = button.dataset.lang;
				if (!i18n.setLanguage(lang, document)) return;
				renderAll();
			});
		}
	}

	async function refresh(options = {}) {
		if (state.busy && !options.force) return;
		if (store && store.isDirty() && !options.force) {
			const ok = await confirm({
				title: i18n.t("刷新会丢弃未保存的修改"),
				body: i18n.t("读取磁盘上的配置会覆盖当前草稿。继续吗？"),
				confirmText: i18n.t("刷新"),
				danger: false,
			});
			if (!ok) return;
		}
		setBusy(true, i18n.t("正在刷新..."));
		try {
			const [configResult, status] = await Promise.all([
				root.PathMask.config.readConfig(),
				root.PathMask.module.probeStatus(),
			]);
			applyLoadedData(configResult, status);
			renderAll();
			refreshPathProbe(true);
			scheduleBootPolling();
			if (!options.silent) toast(i18n.t("已刷新"));
		} catch (error) {
			if (!options.silent) toast(error.message || i18n.t("读取失败"), "danger");
			if (options.throwOnError) throw error;
		} finally {
			setBusy(false);
			updateHeader();
		}
	}

	async function applyChanges(reload) {
		if (state.busy || !store) return;
		const draft = store.getDraft();
		const validation = root.PathMask.config.validateConfig(draft, i18n.t);
		state.validation = validation;
		if (!validation.ok) {
			toast(validation.errors[0], "danger");
			navigate("targets");
			return;
		}
		if (!reload) {
			const ok = await confirm({
				title: i18n.t("仅保存配置"),
				body: i18n.t("配置会写入磁盘，但当前运行状态不会改变；需要重启或稍后点“应用并重载”才生效。"),
				confirmText: i18n.t("仅保存"),
				danger: false,
			});
			if (!ok) return;
		}
		setBusy(true, reload ? i18n.t("正在热重载...") : i18n.t("正在保存..."));
		try {
			const preflight = await root.PathMask.module.preflightConfig(draft, state.status || {}, {
				requireModule: reload,
			});
			state.validation = {
				ok: preflight.ok,
				errors: [...validation.errors, ...preflight.errors],
				warnings: [...validation.warnings, ...preflight.warnings],
			};
			if (!preflight.ok) {
				toast(preflight.errors[0], "danger");
				navigate("targets");
				return;
			}
			let status;
			let warning = preflight.warnings[0] || "";
			if (reload) {
				const result = await root.PathMask.module.reloadModule(draft);
				status = result.status;
				if (result.output) {
					setLogs({ ...state.logs, kernel: result.output });
				}
			} else {
				await root.PathMask.module.saveOnly(draft);
				status = await root.PathMask.module.probeStatus();
			}
			store.commit(draft);
			state.status = status;
			updateHeader();
			renderAll();
			refreshPathProbe(true);
			scheduleBootPolling();
			await refreshDiagnostics({ silent: true, saveHistory: false });
			const notLoaded = reload && !status.loaded && !status.waiting && !status.paused;
			const message = notLoaded
				? i18n.t("热重载完成，但模块未加载")
				: (reload ? i18n.t("热重载完成") : i18n.t("已保存，重启后生效"));
			if (warning && !notLoaded) warning = `${message} · ${warning}`;
			toast(notLoaded ? message : (warning || message), notLoaded ? "danger" : "");
		} catch (error) {
			try {
				state.status = await root.PathMask.module.probeStatus();
				updateHeader();
				renderAll();
				refreshPathProbe(true);
			} catch (probeError) {
				// Keep the original error visible.
			}
			toast(error.message || String(error), "danger");
		} finally {
			setBusy(false);
			updateHeader();
		}
	}

	async function discardChanges() {
		if (!store || !store.isDirty()) return;
		const ok = await confirm({
			title: i18n.t("丢弃未保存的修改"),
			body: i18n.t("当前草稿会恢复为上次保存的配置。"),
			confirmText: i18n.t("丢弃"),
		});
		if (!ok) return;
		store.resetDraft();
		renderAll();
		toast(i18n.t("已丢弃未保存的修改"));
	}

	function confirm(options = {}) {
		return new Promise((resolve) => {
			confirmResolver = resolve;
			if (dom.confirmTitle) dom.confirmTitle.textContent = options.title || i18n.t("确认操作");
			if (dom.confirmBody) dom.confirmBody.textContent = options.body || "";
			if (dom.confirmOk) {
				dom.confirmOk.textContent = options.confirmText || i18n.t("确认");
				dom.confirmOk.className = options.danger === false ? "button primary" : "button danger";
			}
			dom.confirmDialog.hidden = false;
			document.body.classList.add("is-locked");
			window.setTimeout(() => dom.confirmCancel && dom.confirmCancel.focus(), 20);
		});
	}

	function closeConfirm(value) {
		if (!dom.confirmDialog || dom.confirmDialog.hidden) return;
		dom.confirmDialog.hidden = true;
		document.body.classList.remove("is-locked");
		const resolve = confirmResolver;
		confirmResolver = null;
		if (resolve) resolve(value === true);
	}

	/*
	 * One bottom sheet is reused for the path editor, help, history and
	 * donation QR. content can be a string or a DOM node; onSave may
	 * return false to keep the sheet open after a validation failure.
	 */
	function openSheet(options = {}) {
		if (!dom.sheet) return;
		dom.sheetTitle.textContent = options.title || "";
		dom.sheetBody.textContent = "";
		if (typeof options.content === "string") dom.sheetBody.innerHTML = options.content;
		else if (options.content instanceof Node) dom.sheetBody.append(options.content);
		dom.sheetActions.hidden = options.hideActions === true;
		dom.sheetSave.textContent = options.saveText || i18n.t("保存");
		dom.sheetSave.hidden = options.hideSave === true;
		sheetSaveHandler = options.onSave || null;
		dom.sheet.hidden = false;
		document.body.classList.add("is-locked");
		window.setTimeout(() => {
			const first = dom.sheetBody.querySelector("input, textarea, button");
			if (first) first.focus();
		}, 30);
	}

	function closeSheet() {
		if (!dom.sheet) return;
		dom.sheet.hidden = true;
		dom.sheetBody.textContent = "";
		sheetSaveHandler = null;
		document.body.classList.remove("is-locked");
	}

	function toast(message, type) {
		if (!dom.toast) return;
		dom.toast.textContent = message || "";
		dom.toast.className = `toast${type === "danger" ? " danger" : ""}`;
		dom.toast.hidden = false;
		window.clearTimeout(toastTimer);
		toastTimer = window.setTimeout(() => {
			dom.toast.hidden = true;
		}, 3800);
	}

	function getLogsFor(tab = state.logTab) {
		return state.logs[tab] || "";
	}

	function setLogs(next) {
		state.logs = { ...state.logs, ...next };
	}

	function setDiagnostics(value) {
		state.diagnostics = value;
	}

	const app = {
		applyChanges,
		closeConfirm,
		closeSheet,
		confirm,
		discardChanges,
		getDraft,
		getLogsFor,
		getState,
		init,
		navigate,
		openSheet,
		refresh,
		refreshDiagnostics,
		refreshPathProbe,
		renderAll,
		renderView,
		runExclusive,
		setDiagTab,
		setDiagnostics,
		setDraft,
		setLogTab,
		setLogs,
		setTargetsTab,
		toast,
		updateDraft,
		format,
		bridge,
		i18n,
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}

	return app;
});
