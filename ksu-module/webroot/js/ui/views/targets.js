/*
 * Targets view: paths, scope and app selection.
 *
 * All edits go into the draft. Opening this view is intentionally cheap:
 * it probes path existence once per path-list signature and loads the app
 * list only when the Apps segment is opened.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../../core/format.js") : root.PathMask.format;
	const appsApi = isNode ? require("../../domain/apps.js") : root.PathMask.apps;
	const api = factory(root, format, appsApi);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.views = root.PathMask.views || {};
		root.PathMask.views.targets = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format, appsApi) {
	"use strict";

	function defaultTranslate(source, params) {
		return String(source).replace(/\{(\d+)\}/g, (match, index) => (
			params && params[Number(index)] !== undefined ? String(params[Number(index)]) : match
		));
	}

	function validatePathDraft(candidate, paths, editingIndex = -1, t = defaultTranslate) {
		const errors = [];
		const path = String(candidate.path || "").trim();
		const group = String(candidate.group || "").trim();
		if (!path) return [t("路径不能为空")];
		if (!path.startsWith("/")) errors.push(t("路径必须是绝对路径：{0}", [path]));
		if (/\s/.test(path)) errors.push(t("路径不能包含空白字符：{0}", [path]));
		if (path.includes(",")) errors.push(t("隐藏路径不能包含英文逗号：{0}", [path]));
		if (group && /[\s:]/.test(group)) errors.push(t("OR 组名不能包含空格或冒号：{0}", [group]));
		if (group.includes(",")) errors.push(t("隐藏路径不能包含英文逗号：{0}", [group]));
		const key = format.joinTargetLine(path, candidate.useParent, group);
		(paths || []).forEach((item, index) => {
			if (index === editingIndex) return;
			const other = format.joinTargetLine(item.path, item.useParent, item.group);
			if (other === key) errors.push(t("路径重复：{0}", [key]));
		});
		return errors;
	}

	function parseBulkPaths(text, existingPaths = [], t = defaultTranslate) {
		const items = [];
		const errors = [];
		for (const line of format.linesFromText(text)) {
			const candidate = format.splitTargetLine(line);
			const rowErrors = validatePathDraft(candidate, [...existingPaths, ...items], -1, t);
			if (rowErrors.length) {
				errors.push(`${line}: ${rowErrors[0]}`);
			} else {
				items.push({ path: candidate.path, useParent: candidate.useParent, group: candidate.group });
			}
		}
		return { items, errors };
	}

	function scopeCopy(scope, t) {
		const normal = format.normalizeScope(scope);
		if (normal === "global") {
			return {
				label: t("全局"),
				hint: t("全局模式：所有应用都看不到隐藏路径。应用列表不参与判断。"),
				appTitle: t("应用列表"),
				uidLabel: t("作用 UID"),
			};
		}
		if (normal === "allow") {
			return {
				label: t("白名单"),
				hint: t("白名单模式：选中的应用不受影响，其他应用默认看不到隐藏路径。"),
				appTitle: t("应用白名单"),
				uidLabel: t("白名单 UID"),
			};
		}
		return {
			label: t("黑名单"),
			hint: t("黑名单模式：勾选的应用会看不到隐藏路径。"),
			appTitle: t("应用黑名单"),
			uidLabel: t("黑名单 UID"),
		};
	}

	function selectionSummary(draft, scope, t) {
		const normal = format.normalizeScope(scope);
		if (normal === "global") {
			return { scope: normal, appCount: 0, uidCount: 0, label: t("全局模式不读取应用列表") };
		}
		const apps = normal === "allow" ? draft.allowPackages : draft.denyPackages;
		const uids = normal === "allow" ? draft.allowUids : draft.denyUids;
		const appCount = apps ? apps.size : 0;
		const uidCount = uids ? uids.length : 0;
		let label;
		if (appCount && uidCount) label = t("已选 {0} 个应用 · {1} 个 UID", [appCount, uidCount]);
		else if (appCount) label = t("已选 {0} 个应用", [appCount]);
		else if (uidCount) label = t("已填写 {0} 个 UID", [uidCount]);
		else label = t("还没有选择应用或 UID");
		return { scope: normal, appCount, uidCount, label };
	}

	function togglePackageSelection(draft, scope, pkg, checked) {
		const normal = format.normalizeScope(scope);
		if (normal === "global") return draft;
		const key = normal === "allow" ? "allowPackages" : "denyPackages";
		const next = { ...draft, [key]: new Set(draft[key] || []) };
		if (checked) next[key].add(pkg);
		else next[key].delete(pkg);
		return next;
	}

	function buildPathProbeCommand(paths) {
		const safe = /^[A-Za-z0-9_./?*@+=,-]+$/;
		return (paths || []).map((item, index) => {
			const raw = String(item.path || "").trim();
			if (!raw || !safe.test(raw)) return `echo "${index}=unknown"`;
			if (raw.includes("?") || raw.includes("*")) {
				const glob = raw.replace(/\?/g, "*");
				return `if ls -d ${glob} >/dev/null 2>&1; then echo "${index}=1"; else echo "${index}=0"; fi`;
			}
			return `if [ -e ${format.shellQuote(raw)} ]; then echo "${index}=1"; else echo "${index}=0"; fi`;
		}).join("; ") || "true";
	}

	function parsePathProbe(text) {
		const map = new Map();
		for (const line of String(text || "").split(/\r?\n/)) {
			const match = line.trim().match(/^(\d+)=(1|0|unknown)$/);
			if (!match) continue;
			const index = Number(match[1]);
			map.set(index, match[2] === "unknown" ? null : match[2] === "1");
		}
		return map;
	}

	function normalizeUidText(text) {
		return format.linesFromText(text);
	}

	function setText(selector, value) {
		const node = document.querySelector(selector);
		if (node) node.textContent = value === undefined || value === null ? "" : String(value);
	}

	function makeNode(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function render(app) {
		const draft = app.getDraft();
		if (!draft) return;
		const state = app.getState();
		const scope = format.normalizeScope(draft.scope);
		renderPaths(app, draft, state);
		renderScope(app, draft, scope);
		renderApps(app, draft, scope);
		if (state.targetsTab === "apps" && !state.appsLoaded && !state.appsLoading) {
			loadApps(app);
		}
		const signature = JSON.stringify((draft.paths || []).map((item) => [item.path, item.useParent, item.group]));
		if (state.pathProbeSignature !== signature && !state.pathProbing) {
			probePaths(app);
		}
	}

	function renderPaths(app, draft, state) {
		const container = document.getElementById("pathList");
		const empty = document.getElementById("pathEmpty");
		if (!container) return;
		container.textContent = "";
		const paths = draft.paths || [];
		paths.forEach((item, index) => {
			const row = document.createElement("div");
			row.className = "pathRow";
			const errors = validatePathDraft(item, paths, index, app.i18n.t);
			if (errors.length) row.classList.add("is-invalid");

			const main = makeNode("div", "pathMain");
			const value = makeNode("div", "pathValue", item.path);
			main.append(value);

			const badges = makeNode("div", "pathBadges");
			if (item.group) badges.append(badge(item.group, "group"));
			if (item.useParent) badges.append(badge(app.i18n.t("父级"), ""));
			const probe = state.pathStatus ? state.pathStatus.get(index) : undefined;
			if (errors.length) {
				badges.append(badge(errors[0], "invalid"));
			} else if (state.pathProbeHidden) {
				const resolved = Number.isFinite(state.pathResolvedCount) ? state.pathResolvedCount : -1;
				if (resolved >= paths.length) {
					badges.append(badge(app.i18n.t("已由内核隐藏"), "exists"));
				} else if (resolved >= 0) {
					badges.append(badge(app.i18n.t("内核解析 {0}/{1}", [resolved, paths.length]), ""));
				} else {
					badges.append(badge(app.i18n.t("无法探测"), ""));
				}
			} else if (probe === true) {
				badges.append(badge(app.i18n.t("存在"), "exists"));
			} else if (probe === false) {
				badges.append(badge(item.path.includes("?") ? app.i18n.t("未匹配") : app.i18n.t("不存在"), "missing"));
			} else if (probe === null) {
				badges.append(badge(app.i18n.t("无法探测"), ""));
			}
			main.append(badges);
			row.append(main);

			const actions = document.createElement("div");
			actions.className = "pathActions";
			const edit = iconButton("✎", app.i18n.t("编辑路径"), () => openPathEditor(app, index));
			const remove = iconButton("×", app.i18n.t("删除路径"), () => removePath(app, index));
			actions.append(edit, remove);
			row.append(actions);
			container.append(row);
		});
		if (empty) empty.hidden = paths.length > 0;

		const add = document.getElementById("targetsAddPathBtn");
		if (add) add.onclick = () => openPathEditor(app, -1);
		const emptyAdd = document.getElementById("emptyAddPathBtn");
		if (emptyAdd) emptyAdd.onclick = () => openPathEditor(app, -1);
		const help = document.getElementById("pathHelpBtn");
		if (help) help.onclick = () => showPathHelp(app);
		const bulk = document.getElementById("bulkAddPathsBtn");
		if (bulk) bulk.onclick = () => openBulkAdd(app);
	}

	function badge(text, type) {
		return makeNode("span", `pathBadge${type ? ` ${type}` : ""}`, text);
	}

	function iconButton(label, ariaLabel, onClick) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "iconButton";
		button.textContent = label;
		button.setAttribute("aria-label", ariaLabel);
		button.title = ariaLabel;
		button.onclick = onClick;
		return button;
	}

	function renderScope(app, draft, scope) {
		for (const input of document.querySelectorAll('input[name="scope"]')) {
			const active = input.value === scope;
			input.checked = active;
			const choice = input.closest(".choice");
			if (choice) choice.classList.toggle("is-selected", active);
			input.onchange = () => {
				if (!input.checked) return;
				app.setDraft({ scope: input.value });
				app.renderAll();
			};
		}

		const hideDirents = document.getElementById("hideDirentsInput");
		if (hideDirents) {
			hideDirents.checked = !!draft.hideDirents;
			hideDirents.onchange = () => app.setDraft({ hideDirents: hideDirents.checked });
		}

		const uidInput = document.getElementById("uidInput");
		if (uidInput) {
			const values = scope === "allow" ? draft.allowUids : draft.denyUids;
			uidInput.value = (values || []).join("\n");
			uidInput.oninput = () => {
				const key = scope === "allow" ? "allowUids" : "denyUids";
				app.setDraft({ [key]: normalizeUidText(uidInput.value) });
			};
		}

		const allowRow = document.getElementById("allowSystemUidsRow");
		if (allowRow) allowRow.hidden = scope !== "allow";
		for (const input of document.querySelectorAll("[data-allow-system-uid]")) {
			const uid = String(input.dataset.allowSystemUid || "");
			const selected = new Set(draft.allowSystemUids || []);
			input.checked = selected.has(uid);
			input.disabled = scope !== "allow";
			input.onchange = () => {
				const next = new Set(app.getDraft().allowSystemUids || []);
				if (input.checked) next.add(uid);
				else next.delete(uid);
				app.setDraft({ allowSystemUids: next });
			};
		}

		const scopeHint = document.querySelector("#scopeSection .sectionSub");
		if (scopeHint) scopeHint.textContent = scopeCopy(scope, app.i18n.t).hint;
	}

	function renderApps(app, draft, scope) {
		const copy = scopeCopy(scope, app.i18n.t);
		setText("#appListTitle", copy.appTitle);
		setText("#scopeListHint", copy.hint);
		const summary = selectionSummary(draft, scope, app.i18n.t);
		setText("#appSelectionSummary", summary.label);

		const load = document.getElementById("loadAppsBtn");
		if (load) {
			load.disabled = scope === "global" || app.getState().appsLoading;
			load.onclick = () => loadApps(app, true);
		}
		const search = document.getElementById("searchInput");
		if (search) {
			search.disabled = scope === "global";
			search.value = app.getState().appQuery || "";
			search.oninput = () => {
				app.getState().appQuery = search.value;
				const clear = document.getElementById("clearSearchBtn");
				if (clear) clear.hidden = !search.value;
				renderAppList(app, draft, scope);
			};
		}
		const clear = document.getElementById("clearSearchBtn");
		if (clear) {
			clear.hidden = !(app.getState().appQuery || "");
			clear.onclick = () => {
				app.getState().appQuery = "";
				if (search) search.value = "";
				clear.hidden = true;
				renderAppList(app, draft, scope);
			};
		}
		for (const button of document.querySelectorAll("#appFilters [data-app-filter]")) {
			const active = button.dataset.appFilter === app.getState().appFilter;
			button.classList.toggle("active", active);
			button.disabled = scope === "global";
			button.onclick = () => {
				app.getState().appFilter = button.dataset.appFilter;
				for (const other of document.querySelectorAll("#appFilters [data-app-filter]")) {
					other.classList.toggle("active", other === button);
				}
				renderAppList(app, draft, scope);
			};
		}
		renderAppList(app, draft, scope);
	}

	function renderAppList(app, draft, scope) {
		const container = document.getElementById("appList");
		const empty = document.getElementById("appEmpty");
		if (!container) return;
		container.textContent = "";
		const state = app.getState();
		if (scope === "global") {
			if (empty) {
				empty.hidden = false;
				empty.querySelector("strong").textContent = app.i18n.t("全局模式不读取应用列表");
				empty.querySelector("span").textContent = app.i18n.t("所有应用都看不到隐藏路径，无需逐个勾选。");
			}
			return;
		}
		if (state.appsLoading && !state.apps.length) {
			if (empty) empty.hidden = true;
			for (let i = 0; i < 6; i += 1) {
				const row = makeNode("div", "appRow");
				const icon = makeNode("span", "appIcon skeleton");
				const info = makeNode("span", "appInfo");
				info.append(makeNode("span", "appLabel skeleton", "loading"));
				row.append(icon, info);
				container.append(row);
			}
			if (empty) empty.hidden = true;
			return;
		}
		if (!state.apps.length) {
			if (empty) {
				empty.hidden = false;
				empty.querySelector("strong").textContent = state.appsLoaded
					? app.i18n.t("没有匹配的应用")
					: app.i18n.t("应用列表还没有加载");
				empty.querySelector("span").textContent = state.appsLoaded
					? app.i18n.t("换个关键词，或切换筛选条件。")
					: app.i18n.t("打开“应用”页签会自动加载。");
			}
			return;
		}
		const selected = scope === "allow" ? draft.allowPackages : draft.denyPackages;
		const filtered = appsApi.filterApps(state.apps, {
			query: state.appQuery,
			filter: state.appFilter,
			selected,
		});
		if (!filtered.length) {
			if (empty) {
				empty.hidden = false;
				empty.querySelector("strong").textContent = app.i18n.t("没有匹配的应用");
				empty.querySelector("span").textContent = app.i18n.t("换个关键词，或切换筛选条件。");
			}
			return;
		}
		if (empty) empty.hidden = true;
		for (const item of filtered) {
			const row = document.createElement("label");
			row.className = "appRow";
			row.setAttribute("role", "checkbox");
			row.setAttribute("aria-checked", String(selected.has(item.pkg)));
			row.tabIndex = 0;

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.className = "sr-only";
			checkbox.checked = selected.has(item.pkg);
			checkbox.onchange = () => {
				app.updateDraft((current) => togglePackageSelection(current, scope, item.pkg, checkbox.checked));
				row.setAttribute("aria-checked", String(checkbox.checked));
				setText("#appSelectionSummary", selectionSummary(app.getDraft(), scope, app.i18n.t).label);
			};

			const icon = makeNode("span", "appIcon", (item.label || item.pkg || "?").slice(0, 1).toUpperCase());
			if (item.icon) {
				const img = makeNode("img");
				img.src = item.icon;
				img.alt = "";
				img.loading = "lazy";
				img.onerror = () => img.remove();
				icon.append(img);
			}

			const info = makeNode("span", "appInfo");
			const label = makeNode("span", "appLabel", item.label || item.pkg);
			const meta = makeNode("span", "appMeta", `${item.pkg} · ${item.uid || "?"}`);
			if (item.isSystem) meta.append(" ", makeNode("span", "appTag", app.i18n.t("系统")));
			if (!item.resolved) meta.append(" ", makeNode("span", "appTag unresolved", app.i18n.t("未解析")));
			info.append(label, meta);

			const check = makeNode("span", "appCheck", "✓");
			row.append(checkbox, icon, info, check);
			row.onkeydown = (event) => {
				if (event.key !== " " && event.key !== "Enter") return;
				event.preventDefault();
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event("change"));
			};
			container.append(row);
		}
	}

	async function probePaths(app, force = false) {
		const state = app.getState();
		const draft = app.getDraft();
		if (!draft || !app.bridge) return;
		const paths = draft.paths || [];
		const signature = JSON.stringify(paths.map((item) => [item.path, item.useParent, item.group]));
		if (!force && state.pathProbeSignature === signature) return;
		state.pathProbing = true;
		try {
			const status = state.status || {};
			const scope = format.normalizeScope(draft.scope);
			if (status.loaded && (scope === "global" || scope === "allow")) {
				state.pathProbeHidden = true;
				state.pathResolvedCount = Number.isFinite(status.resolvedCount) ? status.resolvedCount : -1;
				state.pathStatus = new Map();
				state.pathProbeSignature = signature;
				renderPaths(app, app.getDraft(), state);
				return;
			}
			state.pathProbeHidden = false;
			state.pathResolvedCount = -1;
			const output = await app.bridge.execShell(buildPathProbeCommand(paths));
			state.pathStatus = parsePathProbe(output);
			state.pathProbeSignature = signature;
			renderPaths(app, app.getDraft(), state);
		} catch (error) {
			state.pathProbeSignature = signature;
			state.pathStatus = new Map();
		} finally {
			state.pathProbing = false;
		}
	}

	function refreshProbe(app, force = true) {
		const state = app.getState();
		state.pathProbeSignature = "";
		return probePaths(app, force);
	}

	async function loadApps(app, force = false) {
		const state = app.getState();
		if (state.appsLoading) return;
		if (state.appsLoaded && !force) return;
		state.appsLoading = true;
		renderApps(app, app.getDraft(), format.normalizeScope(app.getDraft().scope));
		try {
			let output = await app.bridge.execShell("pm list packages -U 2>/dev/null || pm list packages 2>/dev/null || true");
			let rows = appsApi.parsePackageList(output);
			if (!rows.length) {
				rows = String(output || "").split(/\r?\n/).map((line) => {
					const match = line.trim().match(/^package:(.+)$/);
					return match ? { pkg: match[1], uid: "" } : null;
				}).filter(Boolean);
			}
			let infos = [];
			const hasInfoBridge = app.bridge.detectCapabilities().getPackagesInfo;
			if (hasInfoBridge) {
				for (const chunk of appsApi.chunks(rows.map((row) => row.pkg), 50)) {
					const result = app.bridge.getPackagesInfo(chunk);
					if (Array.isArray(result)) infos = infos.concat(result);
				}
			}
			let userPackages = null;
			if (!infos.length) {
				const userOutput = await app.bridge.execShell("pm list packages -U -3 2>/dev/null || pm list packages -3 2>/dev/null || true");
				let userRows = appsApi.parsePackageList(userOutput);
				if (!userRows.length) {
					userRows = String(userOutput || "").split(/\r?\n/)
						.map((line) => line.trim().match(/^package:(.+)$/))
						.filter(Boolean)
						.map((match) => ({ pkg: match[1], uid: "" }));
				}
				if (userRows.length) userPackages = new Set(userRows.map((row) => row.pkg));
			}
			state.apps = appsApi.mergePackages(rows, infos, userPackages);
			state.appsLoaded = true;
			state.appQuery = state.appQuery || "";
		} catch (error) {
			app.toast(error.message || app.i18n.t("应用列表加载失败"), "danger");
		} finally {
			state.appsLoading = false;
			renderApps(app, app.getDraft(), format.normalizeScope(app.getDraft().scope));
		}
	}

	function openPathEditor(app, index) {
		const draft = app.getDraft();
		const existing = index >= 0 ? draft.paths[index] : { path: "", group: "", useParent: false };
		const form = document.createElement("div");
		form.className = "sheetForm";
		form.innerHTML = `
			<label class="field">
				<span>${app.i18n.t("路径")}</span>
				<input id="pathDraftInput" type="text" spellcheck="false" autocomplete="off" placeholder="/system/app/example">
			</label>
			<label class="switchRow">
				<span>
					<strong>${app.i18n.t("父级")}</strong>
					<small class="hint">${app.i18n.t("勾选后隐藏匹配项的父目录（dir:）。")}</small>
				</span>
				<input id="pathParentInput" type="checkbox">
			</label>
			<label class="field">
				<span>${app.i18n.t("OR 组（可选）")}</span>
				<input id="pathGroupInput" type="text" spellcheck="false" autocomplete="off" placeholder="${app.i18n.t("组")}">
			</label>
			<p class="sheetNote">${app.i18n.t("支持 ??? 通配；同名组内任一行命中即视为满足。")}</p>
			<p id="pathFormError" class="hint" role="alert"></p>
		`;
		const input = form.querySelector("#pathDraftInput");
		input.value = existing.path || "";
		form.querySelector("#pathParentInput").checked = !!existing.useParent;
		form.querySelector("#pathGroupInput").value = existing.group || "";
		app.openSheet({
			title: index >= 0 ? app.i18n.t("编辑路径") : app.i18n.t("添加路径"),
			content: form,
			saveText: index >= 0 ? app.i18n.t("保存") : app.i18n.t("添加"),
			onSave: () => {
				const candidate = {
					path: input.value.trim(),
					group: form.querySelector("#pathGroupInput").value.trim(),
					useParent: form.querySelector("#pathParentInput").checked,
				};
				const errors = validatePathDraft(candidate, app.getDraft().paths, index, app.i18n.t);
				if (errors.length) {
					form.querySelector("#pathFormError").textContent = errors[0];
					input.focus();
					return false;
				}
				app.updateDraft((current) => {
					const paths = [...(current.paths || [])];
					if (index >= 0) paths[index] = candidate;
					else paths.push(candidate);
					return { ...current, paths };
				});
				render(app);
				app.toast(index >= 0 ? app.i18n.t("路径已更新") : app.i18n.t("路径已添加"));
				return true;
			},
		});
	}

	function openBulkAdd(app) {
		const form = document.createElement("div");
		form.className = "sheetForm";
		form.innerHTML = `
			<label class="field">
				<span>${app.i18n.t("每行一条路径")}</span>
				<textarea id="bulkPathInput" rows="8" spellcheck="false" placeholder="/system/app/example&#10;dir:/dev/???/scene_mode_category&#10;any:scene:/dev/cpuset/scene-daemon"></textarea>
			</label>
			<p class="sheetNote">${app.i18n.t("支持 dir: 父级前缀和 any:<组>: 前缀；空行与 # 注释会被忽略。")}</p>
			<p id="bulkPathError" class="hint" role="alert"></p>
		`;
		app.openSheet({
			title: app.i18n.t("批量粘贴路径"),
			content: form,
			saveText: app.i18n.t("添加"),
			onSave: () => {
				const result = parseBulkPaths(form.querySelector("#bulkPathInput").value, app.getDraft().paths, app.i18n.t);
				if (!result.items.length) {
					form.querySelector("#bulkPathError").textContent = result.errors[0] || app.i18n.t("没有可添加的路径");
					return false;
				}
				app.updateDraft((current) => ({
					...current,
					paths: [...(current.paths || []), ...result.items],
				}));
				render(app);
				app.toast(result.errors.length
					? app.i18n.t("已添加 {0} 条，跳过 {1} 条无效路径", [result.items.length, result.errors.length])
					: app.i18n.t("已添加 {0} 条路径", [result.items.length]));
				return true;
			},
		});
	}

	function removePath(app, index) {
		app.updateDraft((current) => ({
			...current,
			paths: (current.paths || []).filter((_, itemIndex) => itemIndex !== index),
		}));
		render(app);
		app.toast(app.i18n.t("路径已删除"));
	}

	function showPathHelp(app) {
		app.openSheet({
			title: app.i18n.t("路径配置说明"),
			hideActions: true,
			content: `
				<div class="sheetForm">
					<p class="sheetNote"><strong>${app.i18n.t("绝对路径")}</strong><br>${app.i18n.t("以 / 开头，指向要隐藏的文件或目录。")}</p>
					<p class="sheetNote"><strong>??? 通配</strong><br>${app.i18n.t("匹配任意一段路径名，不跨 /。例如 /dev/???/scene_mode_category。")}</p>
					<p class="sheetNote"><strong>${app.i18n.t("父级")}</strong><br>${app.i18n.t("隐藏匹配项的父目录，适合随机父目录场景。")}</p>
					<p class="sheetNote"><strong>${app.i18n.t("OR 组")}</strong><br>${app.i18n.t("同名组内任一行存在即可，未分组的行仍需各自存在。")}</p>
				</div>
			`,
		});
	}

	return {
		buildPathProbeCommand,
		loadApps,
		normalizeUidText,
		openBulkAdd,
		openPathEditor,
		parseBulkPaths,
		parsePathProbe,
		probePaths,
		refreshProbe,
		removePath,
		render,
		scopeCopy,
		selectionSummary,
		showPathHelp,
		togglePackageSelection,
		validatePathDraft,
	};
});
