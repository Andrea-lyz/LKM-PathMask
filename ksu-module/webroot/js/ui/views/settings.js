/*
 * Settings view: low-frequency options and maintenance actions.
 *
 * Everything here edits the draft. The sticky apply bar is still the
 * only path that writes to disk, except the two maintenance actions
 * (pause / restore), which are explicitly confirmed first.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../../core/format.js") : root.PathMask.format;
	const api = factory(root, format);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.views = root.PathMask.views || {};
		root.PathMask.views.settings = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format) {
	"use strict";

	function toggleSyscall(draft, name, checked) {
		const next = new Set(draft.syscallHooks || []);
		if (checked) {
			next.add(name);
		} else {
			if (next.size <= 1 && next.has(name)) return draft;
			next.delete(name);
		}
		return { ...draft, syscallHooks: next };
	}

	function buildSettingsModel(draft, status = {}, t = (source) => source) {
		const procguardLabel = draft.procguard ? t("开启") : t("关闭");
		const procguardNote = !draft.procguard
			? t("未启用")
			: status.procguardLoaded
				? t("运行中")
				: t("已启用，等待重载");
		const syscallCount = draft.syscallEnabled ? (draft.syscallHooks ? draft.syscallHooks.size : 0) : 0;
		const syscallNote = draft.syscallEnabled
			? t("已选 {0} 个入口", [syscallCount])
			: t("已关闭");

		const scene = status.scene || {};
		let sceneLabel;
		if (!scene.enabled) sceneLabel = t("关闭");
		else if (scene.appliedEnabled) sceneLabel = t("已生效");
		else sceneLabel = t("已启用，运行中未生效");
		const sceneNote = scene.enabled
			? (scene.count
				? t("已加入 {0} 条运行时路径。", [scene.count])
				: t("还没有发现可用的 debugfs 挂载点。"))
			: t("仅保存，重启后生效。");

		return {
			procguardLabel,
			procguardNote,
			syscallCount,
			syscallNote,
			sceneLabel,
			sceneNote,
			waitSeconds: Number(draft.waitSeconds) || format.DEFAULT_WAIT_SECONDS,
		};
	}

	function setText(selector, value) {
		const node = document.querySelector(selector);
		if (node) node.textContent = value === undefined || value === null ? "" : String(value);
	}

	function render(app) {
		const state = app.getState();
		const draft = app.getDraft();
		if (!draft) return;
		const model = buildSettingsModel(draft, state.status || {}, app.i18n.t);

		const procguard = document.getElementById("procguardEnableInput");
		if (procguard) {
			procguard.checked = !!draft.procguard;
			procguard.onchange = () => app.setDraft({ procguard: procguard.checked });
		}
		setText("#procguardStats", `${model.procguardLabel} · ${model.procguardNote}`);

		for (const input of document.querySelectorAll('input[name="writePolicy"]')) {
			const active = input.value === draft.writePolicy;
			input.checked = active;
			const choice = input.closest(".choice");
			if (choice) choice.classList.toggle("is-selected", active);
			input.onchange = () => {
				if (!input.checked) return;
				app.setDraft({ writePolicy: input.value });
				render(app);
			};
		}

		const enableSyscall = document.getElementById("enableSyscallHooksInput");
		if (enableSyscall) {
			enableSyscall.checked = !!draft.syscallEnabled;
			enableSyscall.onchange = () => {
				app.setDraft({ syscallEnabled: enableSyscall.checked });
				render(app);
			};
		}
		const details = document.getElementById("syscallHooksDetails");
		if (details) details.open = !!draft.syscallEnabled;
		for (const input of document.querySelectorAll("[data-syscall]")) {
			const name = input.dataset.syscall;
			input.checked = !!(draft.syscallEnabled && draft.syscallHooks && draft.syscallHooks.has(name));
			input.disabled = !draft.syscallEnabled;
			input.onchange = () => {
				if (!input.checked && draft.syscallHooks && draft.syscallHooks.size <= 1) {
					input.checked = true;
					app.toast(app.i18n.t("至少保留一个 syscall 入口"));
					return;
				}
				app.updateDraft((current) => toggleSyscall(current, name, input.checked));
				render(app);
			};
		}
		const syscallCount = document.getElementById("syscallCount");
		if (syscallCount) syscallCount.textContent = model.syscallNote;

		const autoScene = document.getElementById("autoSceneDebugfsInput");
		if (autoScene) {
			autoScene.checked = !!draft.autoSceneDebugfs;
			autoScene.onchange = () => app.setDraft({ autoSceneDebugfs: autoScene.checked });
		}
		const sceneStatus = document.getElementById("autoSceneDebugfsStatus");
		if (sceneStatus) {
			sceneStatus.hidden = false;
			sceneStatus.textContent = `${model.sceneLabel} · ${model.sceneNote}`;
		}

		const wait = document.getElementById("waitSecondsInput");
		if (wait) {
			wait.value = String(model.waitSeconds);
			wait.onchange = () => {
				const parsed = format.parseWaitSeconds(wait.value);
				if (parsed === format.DEFAULT_WAIT_SECONDS && String(wait.value).trim() !== String(format.DEFAULT_WAIT_SECONDS)) {
					app.toast(app.i18n.t("等待秒数必须在 1–600 之间"));
					wait.value = String(app.getDraft().waitSeconds);
					return;
				}
				app.setDraft({ waitSeconds: parsed });
			};
		}

		for (const button of document.querySelectorAll(".langOption")) {
			const active = button.dataset.lang === app.i18n.getLanguage();
			button.classList.toggle("active", active);
			button.setAttribute("aria-pressed", String(active));
		}

		const version = state.moduleInfo && state.moduleInfo.version
			? `v${state.moduleInfo.version}`
			: (document.getElementById("moduleVersion") ? document.getElementById("moduleVersion").textContent : "—");
		setText("#aboutVersion", version);

		const pause = document.getElementById("pauseBtnSettings");
		if (pause) pause.onclick = () => pauseHiding(app);
		const restore = document.getElementById("restoreDefaultsBtn");
		if (restore) restore.onclick = () => restoreDefaults(app);
		const donate = document.getElementById("donateBtn");
		if (donate) donate.onclick = () => openDonate(app);
	}

	async function pauseHiding(app) {
		const ok = await app.confirm({
			title: app.i18n.t("暂停隐藏"),
			body: app.i18n.t("这会立刻卸载 pathmask 内核模块，隐藏路径会恢复可见，直到你重新应用或重启。继续吗？"),
			confirmText: app.i18n.t("暂停隐藏"),
		});
		if (!ok) return;
		try {
			const result = await root.PathMask.module.pauseHiding();
			app.getState().status = result.status;
			app.renderAll();
			app.toast(app.i18n.t("已暂停隐藏"));
		} catch (error) {
			app.toast(error.message || app.i18n.t("暂停失败"), "danger");
		}
	}

	async function restoreDefaults(app) {
		const ok = await app.confirm({
			title: app.i18n.t("恢复默认配置"),
			body: app.i18n.t("路径、范围、应用列表和所有高级选项都会恢复为模块默认值。当前草稿会丢失。"),
			confirmText: app.i18n.t("恢复默认"),
		});
		if (!ok) return;
		try {
			await root.PathMask.module.restoreDefaults();
			const state = app.getState();
			if (state.store) state.store.resetDraft();
			await app.refresh();
			app.toast(app.i18n.t("已恢复默认配置"));
		} catch (error) {
			app.toast(error.message || app.i18n.t("恢复默认失败"), "danger");
		}
	}

	function openDonate(app) {
		const content = document.createElement("div");
		content.className = "sheetForm";
		const note = document.createElement("p");
		note.className = "sheetNote";
		note.textContent = app.i18n.t("如果 PathMask 对你有帮助，欢迎自愿捐赠支持后续维护。");
		const image = document.createElement("img");
		image.className = "donateImage";
		image.src = "./PY_QR.png";
		image.alt = app.i18n.t("微信与支付宝收款二维码");
		image.loading = "lazy";
		const hint = document.createElement("p");
		hint.className = "hint";
		hint.textContent = app.i18n.t("请使用微信或支付宝扫码。感谢支持！");
		content.append(note, image, hint);
		app.openSheet({ title: app.i18n.t("支持 PathMask"), content, hideActions: true });
	}

	return {
		buildSettingsModel,
		openDonate,
		pauseHiding,
		render,
		restoreDefaults,
		toggleSyscall,
	};
});
