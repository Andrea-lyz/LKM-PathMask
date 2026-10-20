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
		capabilities: {},
		moduleInfo: null,
		status: null,
		config: null,
		texts: {},
		apps: [],
		appsLoaded: false,
		appsLoading: false,
		selected: new Set(),
		diagnostics: null,
		report: "",
		history: [],
		logs: { status: "", config: "", kernel: "", script: "" },
		logTab: "status",
		logPage: 0,
		logWrap: true,
		bootPoll: null,
		validation: { ok: true, errors: [], warnings: [] },
	};

	let store = null;
	let confirmResolver = null;
	let sheetSaveHandler = null;
	let toastTimer = null;
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
		state.capabilities = bridge.detectCapabilities();
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

	function updateVersion() {
		let version = state.moduleInfo && state.moduleInfo.version ? String(state.moduleInfo.version) : "";
		if (dom.moduleVersion) dom.moduleVersion.textContent = version ? `v${version}` : "—";
		if (dom.aboutVersion) dom.aboutVersion.textContent = version ? `v${version}` : "—";
		if (version) return;
		bridge.execShell("grep '^version=' /data/adb/modules/pathmask/module.prop 2>/dev/null | head -n1 || true")
			.then((line) => {
				const match = String(line || "").match(/=\s*(.+)/);
				if (!match) return;
				version = match[1].trim();
				if (dom.moduleVersion) dom.moduleVersion.textContent = `v${version}`;
				if (dom.aboutVersion) dom.aboutVersion.textContent = `v${version}`;
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
		state.config = configResult.config;
		state.texts = configResult.texts || {};
		state.status = status;
		state.validation = root.PathMask.config.validateConfig(configResult.config);
		if (!store) {
			state.store = storeApi.createStore(configResult.config);
			store = state.store;
			store.subscribe(onStoreChanged);
		} else {
			store.replaceDraft(configResult.config);
			store.commit(configResult.config);
		}
		updateHeader();
	}

	function onStoreChanged(snapshot) {
		updateApplyBar(snapshot);
		if (snapshot.dirty.length === 0) {
			state.validation = root.PathMask.config.validateConfig(snapshot.draft);
		}
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

	function setBusy(nextBusy, message) {
		state.busy = nextBusy;
		for (const button of $$("button.primary, button.danger, #applyBtn, #saveOnlyBtn, #discardBtn")) {
			button.disabled = nextBusy;
		}
		if (message) setHeaderStatus(message);
	}

	function getDraft() {
		return store ? store.getDraft() : null;
	}

	function getSaved() {
		return store ? store.getSaved() : null;
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

	function navigate(view) {
		if (!["home", "targets", "diagnostics", "settings"].includes(view)) return;
		state.view = view;
		for (const section of $$(".view[data-view]")) {
			section.hidden = section.dataset.view !== view;
		}
		for (const button of $$(".navItem[data-tab]")) {
			const active = button.dataset.tab === view;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		renderView(view);
		window.scrollTo({ top: 0, behavior: "smooth" });
	}

	function setTargetsTab(tab) {
		if (!["paths", "scope", "apps"].includes(tab)) return;
		state.targetsTab = tab;
		for (const pane of $$("#targetsView .targetsPane")) {
			pane.hidden = pane.id !== `${tab}Section`;
		}
		for (const button of $$("#targetsSegments [data-targets-tab]")) {
			const active = button.dataset.targetsTab === tab;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		renderView("targets");
	}

	function setDiagTab(tab) {
		if (!["verdict", "logs", "report"].includes(tab)) return;
		state.diagTab = tab;
		for (const pane of $$("#diagnosticsView .diagPane")) {
			pane.hidden = pane.id !== `${tab}Section`;
		}
		for (const button of $$("#diagSegments [data-diag-tab]")) {
			const active = button.dataset.diagTab === tab;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		renderView("diagnostics");
	}

	function setLogTab(tab) {
		if (!["status", "config", "kernel", "script"].includes(tab)) return;
		state.logTab = tab;
		state.logPage = 0;
		for (const button of $$("#logTabs [data-log]")) {
			const active = button.dataset.log === tab;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		renderView("diagnostics");
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
			module.render(api);
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

	async function refresh() {
		if (state.busy) return;
		if (store && store.isDirty()) {
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
			toast(i18n.t("已刷新"));
		} catch (error) {
			toast(error.message || i18n.t("读取失败"), "danger");
		} finally {
			setBusy(false);
			updateHeader();
		}
	}

	async function applyChanges(reload) {
		if (state.busy || !store) return;
		const draft = store.getDraft();
		const validation = root.PathMask.config.validateConfig(draft);
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
			let status;
			if (reload) {
				const result = await root.PathMask.module.reloadModule(draft);
				status = result.status;
			} else {
				await root.PathMask.module.saveOnly(draft);
				status = await root.PathMask.module.probeStatus();
			}
			store.commit(draft);
			state.config = store.getSaved();
			state.status = status;
			updateHeader();
			renderAll();
			toast(reload ? i18n.t("热重载完成") : i18n.t("已保存，重启后生效"));
		} catch (error) {
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

	function getDiagnostics() {
		return state.diagnostics;
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
		getDiagnostics,
		getLogsFor,
		getSaved,
		getState,
		getStateView: () => state.view,
		init,
		navigate,
		openSheet,
		refresh,
		renderAll,
		renderView,
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
