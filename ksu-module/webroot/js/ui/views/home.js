/*
 * Overview view.
 *
 * The model is pure so the empty/loaded/paused/waiting/dirty states can
 * be tested without a WebView. The renderer only maps that model onto
 * the static shell.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../../core/format.js") : root.PathMask.format;
	const api = factory(root, format);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.views = root.PathMask.views || {};
		root.PathMask.views.home = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format) {
	"use strict";

	function scopeLabel(scope, t) {
		const normal = format.normalizeScope(scope);
		if (normal === "global") return t("全局");
		if (normal === "allow") return t("白名单");
		return t("黑名单");
	}

	function countdownText(status, nowEpoch) {
		const deadline = Number(status && status.boot && status.boot.deadline) || 0;
		const now = Number(nowEpoch) || Math.floor(Date.now() / 1000);
		if (!deadline) return "";
		const left = Math.max(0, deadline - now);
		return String(left);
	}

	function actionLabel(action, t) {
		if (action === "apply") return t("应用并重载");
		if (action === "targets") return t("去配置");
		if (action === "settings") return t("打开设置");
		return t("生成诊断");
	}

	function buildHomeModel(input, t = (source) => source) {
		const draft = input.draft || {};
		const status = input.status || {};
		const diagnostics = input.diagnostics || null;
		const validation = input.validation || { ok: true, errors: [], warnings: [] };
		const dirtyKeys = input.dirtyKeys || [];
		const dirty = dirtyKeys.length > 0;
		const scope = format.normalizeScope(draft.scope);
		const paths = Array.isArray(draft.paths) ? draft.paths : [];
		const parentCount = paths.filter((item) => item.useParent).length;
		const groupCount = new Set(paths.map((item) => item.group).filter(Boolean)).size;
		const selectedPackages = scope === "allow" ? draft.allowPackages : draft.denyPackages;
		const selectedUids = scope === "allow" ? draft.allowUids : draft.denyUids;
		const appCount = scope === "global" ? 0 : (selectedPackages ? selectedPackages.size : 0);
		const uidCount = scope === "global" ? 0 : (selectedUids ? selectedUids.length : 0);
		const guardValue = draft.procguard ? t("开启") : t("关闭");
		const guardNote = draft.procguard
			? (status.procguardLoaded ? t("运行中") : t("已启用，等待重载"))
			: t("未启用");

		let level = "ok";
		let badge = t("运行中");
		let title = t("隐藏已生效");
		let detail = t("模块已加载，隐藏路径和运行参数已就绪。");
		let meta = t("已加载 · {0} 条路径", [paths.length]);
		let issue = null;
		let primaryAction = "diagnose";
		let secondaryAction = "targets";

		if (validation.errors && validation.errors.length) {
			level = "danger";
			badge = t("需处理");
			title = t("配置有问题");
			detail = validation.errors[0];
			meta = t("修正后才能应用");
			issue = {
				title: t("配置有问题"),
				body: validation.errors[0],
				action: "targets",
			};
		} else if (status.error) {
			level = "danger";
			badge = t("需处理");
			title = t("读取配置失败");
			detail = status.error;
			meta = t("检查 WebUI 权限");
			issue = { title: t("读取配置失败"), body: status.error, action: "diagnose" };
		} else if (status.failed) {
			level = "danger";
			badge = t("需处理");
			title = t("模块加载失败");
			detail = status.failReason || t("加载失败，生成诊断查看原因。");
			meta = t("已尝试加载");
			issue = {
				title: t("模块加载失败"),
				body: status.failReason || t("加载失败，生成诊断查看原因。"),
				action: "diagnose",
			};
		} else if (status.waiting) {
			level = "warn";
			badge = t("等待中");
			title = t("正在等待目标出现");
			const left = countdownText(status, input.nowEpoch);
			detail = left
				? t("开机等待还剩约 {0} 秒；超时后会跳过本次加载。", [left])
				: t("模块正在等待隐藏路径或包名解析完成。");
			meta = t("开机等待");
			primaryAction = "diagnose";
			if (dirty) {
				issue = {
					title: t("有未保存的修改"),
					body: t("当前改动还没有写入磁盘；应用并重载会立即覆盖运行配置。"),
					action: "apply",
				};
			}
		} else if (status.paused) {
			level = "info";
			badge = t("已暂停");
			title = t("隐藏已暂停");
			detail = t("模块已卸载，隐藏路径恢复可见。应用并重载可恢复。");
			meta = t("手动暂停");
			primaryAction = "apply";
			secondaryAction = "diagnose";
		} else if (!status.loaded) {
			level = "danger";
			badge = t("未加载");
			title = t("模块未加载");
			detail = status.boot && status.boot.state
				? t("boot_state：{0}。生成诊断查看失败原因。", [status.boot.state])
				: t("没有找到运行中的 pathmask 模块。");
			meta = status.legacyLoaded ? t("旧模块仍在运行") : t("未加载");
			primaryAction = "diagnose";
			issue = {
				title: t("模块未加载"),
				body: detail,
				action: "diagnose",
			};
		} else if (diagnostics && diagnostics.level === "danger") {
			level = "danger";
			badge = t("需处理");
			title = diagnostics.title || t("诊断发现问题");
			detail = diagnostics.detail || t("打开诊断查看详情。");
			meta = t("最近诊断");
			issue = { title, body: detail, action: "diagnose" };
		} else if (dirty) {
			level = "warn";
			badge = t("有改动");
			title = t("有未保存的修改");
			detail = t("改动只保存在当前页面；应用并重载后才会写入磁盘并生效。");
			meta = t("{0} 项待应用", [dirtyKeys.length]);
			primaryAction = "apply";
			issue = {
				title: t("有未保存的修改"),
				body: t("点击“应用并重载”写入配置；只想留到下次重启可以点“仅保存”。"),
				action: "apply",
			};
		} else if (diagnostics && diagnostics.level === "warn") {
			level = "warn";
			badge = t("有提醒");
			title = diagnostics.title || t("诊断有提醒");
			detail = diagnostics.detail || t("打开诊断查看详情。");
			meta = t("最近诊断");
			primaryAction = "diagnose";
		} else if (!paths.length) {
			level = "warn";
			badge = t("待配置");
			title = t("还没有隐藏路径");
			detail = t("先添加一条路径，再保存并重载。");
			meta = t("0 条路径");
			primaryAction = "targets";
			issue = {
				title: t("还没有隐藏路径"),
				body: t("添加路径后，隐藏才会实际发生。"),
				action: "targets",
			};
		}

		if (!dirty && validation.warnings && validation.warnings.length && level === "ok") {
			level = "warn";
			badge = t("有提醒");
			detail = validation.warnings[0];
		}

		const appNote = scope === "global"
			? t("应用列表不参与")
			: appCount
				? t("{0} 个应用", [appCount])
				: t("未选择应用");
		const uidNote = scope === "global"
			? t("全部应用")
			: uidCount
				? t("{0} 个 UID", [uidCount])
				: t("未直接填写 UID");
		const lastCheck = diagnostics && diagnostics.timestamp
			? new Date(diagnostics.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: t("—");
		const lastCheckNote = diagnostics
			? (diagnostics.level === "ok" ? t("通过") : diagnostics.level === "warn" ? t("有提醒") : t("有问题"))
			: t("还没有生成诊断");

		return {
			level,
			badge,
			title,
			detail,
			meta,
			issue,
			primaryAction,
			primaryLabel: actionLabel(primaryAction, t),
			secondaryAction,
			secondaryLabel: actionLabel(secondaryAction, t),
			pathCount: paths.length,
			pathNote: paths.length
				? [parentCount ? t("{0} 条父级", [parentCount]) : "", groupCount ? t("{0} 个 OR 组", [groupCount]) : ""]
					.filter(Boolean).join(" · ")
				: t("还没有配置"),
			appCount,
			appNote: `${appNote}${uidNote ? ` · ${uidNote}` : ""}`,
			guardValue,
			guardNote,
			uidCount,
			scopeLabel: scopeLabel(scope, t),
			scopeText: scope === "global"
				? t("全局模式：所有应用都看不到隐藏路径。")
				: scope === "allow"
					? t("白名单模式：选中的应用不受影响，其他应用看不到隐藏路径。")
					: t("黑名单模式：只有选中的应用看不到隐藏路径。"),
			lastCheck,
			lastCheckNote,
			dirty,
			dirtyCount: dirtyKeys.length,
			paths: paths.map((item) => ({
				path: item.path,
				group: item.group || "",
				useParent: !!item.useParent,
			})),
			apps: scope === "global" ? [] : [...(selectedPackages || new Set())].slice(0, 12).map((pkg) => ({ pkg })),
			diagnostics,
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
		const model = buildHomeModel({
			draft,
			status: state.status,
			diagnostics: state.diagnostics,
			validation: state.validation,
			dirtyKeys: state.store ? state.store.getDirtyKeys() : [],
			nowEpoch: Math.floor(Date.now() / 1000),
		}, app.i18n.t);

		const hero = document.getElementById("statusHero");
		if (hero) hero.dataset.level = model.level;
		setText("#heroBadge", model.badge);
		setText("#heroTitle", model.title);
		setText("#heroDetail", model.detail);
		setText("#heroMeta", model.meta);
		setText("#homePathCount", model.pathCount);
		setText("#homePathNote", model.pathNote);
		setText("#homeAppCount", model.appCount);
		setText("#homeAppNote", model.appNote);
		setText("#homeGuardCount", model.guardValue);
		setText("#homeGuardNote", model.guardNote);
		setText("#homeLastCheck", model.lastCheck);
		setText("#homeLastCheckNote", model.lastCheckNote);
		setText("#homeScopeText", model.scopeText);
		setText("#lastDiagSummary", model.diagnostics
			? model.diagnostics.detail || model.diagnostics.title || ""
			: app.i18n.t("还没有生成诊断。"));

		renderPaths(model, app);
		renderApps(model, app);
		renderIssue(model, app);
		bindActions(model, app);
	}

	function renderPaths(model, app) {
		const container = document.getElementById("homePaths");
		const empty = document.getElementById("homePathsEmpty");
		if (!container) return;
		container.textContent = "";
		for (const item of model.paths) {
			const chip = document.createElement("span");
			chip.className = "chip";
			if (item.group) {
				const tag = document.createElement("span");
				tag.className = "chipTag";
				tag.textContent = item.group;
				chip.append(tag);
			}
			const value = document.createElement("span");
			value.textContent = item.path;
			chip.append(value);
			if (item.useParent) {
				const tag = document.createElement("span");
				tag.className = "chipTag";
				tag.textContent = app.i18n.t("父级");
				chip.append(tag);
			}
			container.append(chip);
		}
		if (empty) empty.hidden = model.paths.length > 0;
	}

	function renderApps(model, app) {
		const container = document.getElementById("homeApps");
		const empty = document.getElementById("homeAppsEmpty");
		if (!container) return;
		container.textContent = "";
		if (model.apps.length) {
			for (const item of model.apps) {
				const chip = document.createElement("span");
				chip.className = "chip muted";
				chip.textContent = item.pkg;
				container.append(chip);
			}
		} else {
			const chip = document.createElement("span");
			chip.className = "chip muted";
			chip.textContent = model.scopeLabel === app.i18n.t("全局")
				? app.i18n.t("全部应用")
				: app.i18n.t("未选择应用");
			container.append(chip);
		}
		if (empty) empty.hidden = true;
	}

	function renderIssue(model, app) {
		const banner = document.getElementById("issueBanner");
		if (!banner) return;
		if (!model.issue) {
			banner.hidden = true;
			return;
		}
		banner.hidden = false;
		setText("#issueTitle", model.issue.title);
		setText("#issueBody", model.issue.body);
		const button = document.getElementById("issueFixBtn");
		if (button) {
			button.textContent = model.issue.action === "apply"
				? app.i18n.t("应用修改")
				: model.issue.action === "targets"
					? app.i18n.t("去处理")
					: app.i18n.t("生成诊断");
			button.onclick = () => runAction(model.issue.action, app);
		}
	}

	function bindActions(model, app) {
		const primary = document.getElementById("heroPrimaryBtn");
		const secondary = document.getElementById("heroSecondaryBtn");
		if (primary) {
			primary.textContent = model.primaryLabel;
			primary.onclick = () => runAction(model.primaryAction, app);
		}
		if (secondary) {
			secondary.textContent = model.secondaryLabel;
			secondary.onclick = () => runAction(model.secondaryAction, app);
		}
		const editPaths = document.getElementById("editPathsBtn");
		if (editPaths) editPaths.onclick = () => {
			app.navigate("targets");
			app.setTargetsTab("paths");
		};
		const editScope = document.getElementById("editScopeBtn");
		if (editScope) editScope.onclick = () => {
			app.navigate("targets");
			app.setTargetsTab("scope");
		};
		const addPath = document.getElementById("homeAddPathBtn");
		if (addPath) addPath.onclick = () => {
			app.navigate("targets");
			app.setTargetsTab("paths");
			const targets = root.PathMask.views.targets;
			if (targets && typeof targets.addPath === "function") targets.addPath(app);
		};
		const pickApps = document.getElementById("homePickAppsBtn");
		if (pickApps) pickApps.onclick = () => {
			app.navigate("targets");
			app.setTargetsTab("apps");
		};
		const diagnose = document.getElementById("homeDiagnoseBtn");
		if (diagnose) diagnose.onclick = () => runDiagnostics(app);
		const pause = document.getElementById("homePauseBtn");
		if (pause) pause.onclick = () => {
			const settings = root.PathMask.views.settings;
			if (settings && typeof settings.pause === "function") settings.pause(app);
			else app.toast(app.i18n.t("请在设置中暂停隐藏"));
		};
		const openDiag = document.getElementById("openDiagnosticsBtn");
		if (openDiag) openDiag.onclick = () => app.navigate("diagnostics");
	}

	function runAction(action, app) {
		if (action === "apply") {
			app.applyChanges(true);
			return;
		}
		if (action === "targets") {
			app.navigate("targets");
			app.setTargetsTab("paths");
			return;
		}
		if (action === "settings") {
			app.navigate("settings");
			return;
		}
		runDiagnostics(app);
	}

	function runDiagnostics(app) {
		app.navigate("diagnostics");
		const diagnostics = root.PathMask.views.diagnostics;
		if (diagnostics && typeof diagnostics.run === "function") diagnostics.run(app);
	}

	return { buildHomeModel, render };
});
