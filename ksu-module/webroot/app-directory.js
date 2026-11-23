(() => {
	"use strict";

	const pageSize = 80;
	const svgNS = "http://www.w3.org/2000/svg";
	const node = (tag, cls, text) => {
		const el = document.createElement(tag);
		if (cls) el.className = cls;
		if (text !== undefined) el.textContent = text;
		return el;
	};

	function setIcon(host, pkg) {
		const svg = document.createElementNS(svgNS, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.8");
		const path = document.createElementNS(svgNS, "path");
		path.setAttribute("d", "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z");
		svg.append(path);
		host.replaceChildren(svg);
		if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(pkg)) return;
		const image = node("img");
		image.alt = "";
		image.loading = "lazy";
		image.decoding = "async";
		image.addEventListener("load", () => { image.classList.add("loaded"); svg.remove(); }, { once: true });
		image.addEventListener("error", () => image.remove(), { once: true });
		image.src = "ksu://icon/" + encodeURIComponent(pkg);
		host.append(image);
	}

	const emptyDraft = () => ({ enabled: false, filterDirectory: false, paths: [] });
	const copyDraft = draft => ({ ...draft, paths: draft.paths.slice() });
	const equal = (a, b) => a.enabled === b.enabled && a.filterDirectory === b.filterDirectory
		&& a.paths.length === b.paths.length && a.paths.every((path, i) => path === b.paths[i]);

	function mount({ t, readApps, matches, navigate, getLegacySnapshot, applyProfiles }) {
		const by = id => document.getElementById(id);
		const codec = window.PathMaskProfileDrafts;
		if (!codec || !by("appDraftBackupInput")) return null;
		const draftKey = codec.appKey;
		const list = by("directoryList"), status = by("directoryStatus"), search = by("directorySearch");
		const includeSystem = by("directorySystemInput"), more = by("directoryMoreBtn");
		const enable = by("draftEnabled"), filter = by("draftDirectoryFilter"), input = by("draftPathInput");
		const save = by("saveAppDraftBtn"), discard = by("discardDraftChangesBtn");
		const errorNode = by("draftPathError");
		const pathList = by("draftPathList"), appName = by("detailAppName");
		// Session-only drafts. Neither saving nor editing them calls the bridge.
		const editing = new Map(), saved = new Map();
		let state = "idle", entries = [], request = 0, limit = pageSize;
		let current = null, selectedKey = null, previousScroll = 0, pathError = "";
		const applyState = by("profileApplyState");
		// The applied ruleset, not the draft store: only enabled profiles with
		// at least one path are written, because a disabled or empty profile
		// must not create a rule.
		const applyRows = () => {
			const rows = [];
			const skipped = [];
			for (const [key, value] of [...saved.entries()].sort()) {
				const separator = key.indexOf(":");
				const user = key.slice(0, separator);
				const pkg = key.slice(separator + 1);
				if (!value.enabled || !value.paths.length) continue;
				if (!/^\d+$/.test(user)) { skipped.push(pkg); continue; }
				rows.push("app " + user + " " + pkg + " 1 " + (value.filterDirectory ? "1" : "0"));
				for (const path of value.paths) rows.push("path " + path);
			}
			return { rows, skipped };
		};
		let armed = false;
		let armTimer = 0;
		function disarm() {
			armed = false;
			clearTimeout(armTimer);
			armTimer = 0;
		}
		async function applySavedDrafts() {
			if (typeof applyProfiles !== "function") return;
			const { rows, skipped } = applyRows();
			applyState.textContent = t("正在应用逐应用规则...");
			by("applyProfilesBtn").disabled = true;
			try {
				await applyProfiles(rows.join("\n"));
				const count = rows.filter(row => row.startsWith("app ")).length;
				applyState.textContent = skipped.length
					? t("已应用 {0} 个应用；{1} 个应用无法确定 Android 用户，未写入。", [count, skipped.length])
					: t("已写入并热重载 {0} 个应用规则。", [count]);
			} catch (error) {
				applyState.textContent = t("应用失败：{0}", [error && error.message ? error.message : String(error)]);
			} finally {
				by("applyProfilesBtn").disabled = false;
			}
		}
		let previewRequested = false, backupStatus = null;
		const uidText = app => "UID " + (app.uid || t("未知"));
		const draft = () => editing.get(selectedKey);

		function hasDraft(key) {
			return saved.has(key) || editing.has(key) && !equal(editing.get(key), emptyDraft());
		}

		function row(app) {
			const key = draftKey(app);
			const li = node("li");
			const button = node("button", "directoryRow");
			button.type = "button";
			button.dataset.directoryKey = key;
			const icon = node("span", "directoryIcon");
			icon.setAttribute("aria-hidden", "true");
			setIcon(icon, app.pkg);
			const info = node("span", "directoryInfo");
			info.append(node("strong", "", app.label || app.pkg), node("span", "hint", app.pkg));
			if (app.system) info.append(node("span", "hint", t("系统应用")));
			const meta = node("span", "directoryMeta");
			meta.append(node("span", "uid", uidText(app)));
			if (hasDraft(key)) meta.append(node("span", "directoryBadge", t("有草稿")));
			button.append(icon, info, meta);
			button.addEventListener("click", () => showDetail(app));
			li.append(button);
			return li;
		}

		function renderList() {
			const query = search.value.trim().toLowerCase();
			const results = state === "ready" ? entries.filter(app => matches(app, query)) : [];
			const shown = results.slice(0, limit);
			const fragment = document.createDocumentFragment();
			for (const app of shown) fragment.append(row(app));
			list.replaceChildren(fragment);
			list.hidden = !shown.length;
			more.hidden = shown.length === results.length;
			by("refreshDirectoryBtn").disabled = state === "loading";
			if (state === "loading") status.textContent = t("正在加载应用...");
			else if (state === "error") status.textContent = t("无法读取应用列表，请确认已在 KernelSU WebUI 中打开后重试。");
			else if (state === "ready") {
				if (!results.length) status.textContent = t("没有匹配的应用");
				else if (!more.hidden) status.textContent = t("已显示 {0} 个，共匹配 {1} 个应用", [shown.length, results.length]);
				else status.textContent = t("共 {0} 个应用", [results.length]);
			}
		}

		async function refresh() {
			const token = ++request;
			state = "loading";
			limit = pageSize;
			renderList();
			try {
				const apps = await readApps(includeSystem.checked);
				if (token !== request) return;
				const unique = new Map(apps.map(app => [draftKey(app), app]));
				entries = [...unique.values()].sort((a, b) => (a.label || a.pkg).localeCompare(b.label || b.pkg) || a.pkg.localeCompare(b.pkg));
				state = "ready";
			} catch (_) {
				if (token !== request) return;
				state = "error";
			}
			renderList();
		}

		function renderLegacyPreview() {
			if (!previewRequested) return;
			const output = by("legacyMigrationPreview");
			const result = codec.inspectLegacy(getLegacySnapshot());
			output.hidden = false;
			if (result.mode === "unknown") {
				output.textContent = t("尚未读到明确的旧版模式。请刷新页面配置后再检查。");
				return;
			}
			const mode = result.mode === "deny" ? t("黑名单") : result.mode === "allow" ? t("白名单") : t("全局");
			const notes = [t("旧版模式：{0}。路径条目：{1}。", [mode, result.paths])];
			if (result.mode !== "global") notes.push(t("包名条目：{0}；直接 UID 条目：{1}。", [result.packages, result.uids]));
			if (result.mode !== "deny") notes.push(t("白名单或全局模式不能通过枚举已安装应用等价转换。"));
			if (result.nonLiteralPaths) notes.push(t("有 {0} 条路径不是普通绝对路径，需要单独核对。", [result.nonLiteralPaths]));
			if (result.uids) notes.push(t("直接 UID 不能当作应用的持久标识。"));
			notes.push(t("只读预览：未转换任何条目，旧版配置保持原样。"));
			output.textContent = notes.join("\n");
		}

		function renderBackupStatus() {
			const status = by("appDraftBackupStatus");
			if (!backupStatus) { status.textContent = ""; return; }
			if (backupStatus.error === "size") status.textContent = t("草稿备份超过大小限制，现有草稿未更改。");
			else if (backupStatus.error === "version") status.textContent = t("不支持此草稿备份版本。已保留输入，没有导入任何内容。");
			else if (backupStatus.error) status.textContent = t("草稿备份格式不正确，现有草稿未更改。");
			else if (backupStatus.exported !== undefined) status.textContent = t("已生成 {0} 个草稿的备份。请复制保存。", [backupStatus.exported]);
			else status.textContent = t("已导入 {0} 个草稿，保留 {1} 个现有草稿。均未应用。", [backupStatus.added, backupStatus.kept]);
		}

		function exportDrafts() {
			const result = codec.encodeBackup(saved);
			if (result.error) backupStatus = { error: result.error };
			else {
				const output = by("appDraftBackupOutput");
				output.value = result.text;
				by("appDraftBackupOutputLabel").hidden = output.hidden = false;
				backupStatus = { exported: saved.size };
				output.focus();
				output.select();
			}
			renderBackupStatus();
		}

		function importDrafts() {
			const input = by("appDraftBackupInput");
			const decoded = codec.decodeBackup(input.value);
			if (decoded.error) {
				backupStatus = { error: decoded.error };
				input.setAttribute("aria-invalid", "true");
				input.focus();
				renderBackupStatus();
				return;
			}
			const next = new Map(saved);
			const added = [];
			let kept = 0;
			for (const [key, value] of decoded.profiles) {
				if (hasDraft(key)) kept++;
				else { next.set(key, value); added.push(key); }
			}
			// Admission also checks the merged result, so everything we import is exportable.
			const check = codec.encodeBackup(next);
			if (check.error) backupStatus = { error: check.error };
			else {
				for (const key of added) {
					const value = next.get(key);
					saved.set(key, copyDraft(value));
					if (editing.has(key)) editing.set(key, copyDraft(value));
				}
				backupStatus = { added: added.length, kept };
				input.removeAttribute("aria-invalid");
				renderList();
				if (current) paintDetail();
			}
			renderBackupStatus();
		}

		function updatePathError() {
			input.setAttribute("aria-invalid", String(!!pathError));
			errorNode.hidden = !pathError;
			errorNode.textContent = pathError === "duplicate" ? t("这条路径已经添加。")
				: pathError === "invalid" ? t("请输入非根目录的绝对路径。")
				: pathError === "full" ? t("此草稿的路径数量已达上限。") : "";
		}

		function paintDraft() {
			const value = draft();
			const dirty = !equal(value, saved.get(selectedKey) ?? emptyDraft());
			save.disabled = discard.disabled = !dirty;
			by("draftSaveState").textContent = dirty ? t("草稿有未保存的更改") : saved.has(selectedKey) ? t("已保存草稿（未应用）") : "";
		}

		function paintPaths() {
			const { paths } = draft();
			const fragment = document.createDocumentFragment();
			paths.forEach((path, index) => {
				const li = node("li");
				const remove = node("button", "textButton", t("删"));
				remove.type = "button";
				remove.setAttribute("aria-label", t("删除路径") + ": " + path);
				remove.addEventListener("click", () => {
					draft().paths.splice(index, 1);
					paintPaths();
					paintDraft();
					(pathList.querySelectorAll("button")[index] || input).focus();
				});
				li.append(node("code", "", path), remove);
				fragment.append(li);
			});
			pathList.replaceChildren(fragment);
			by("draftPathCount").textContent = String(paths.length);
			by("draftPathEmpty").hidden = !!paths.length;
		}

		function paintDetail() {
			appName.textContent = current.label || current.pkg;
			by("detailAppPackage").textContent = current.pkg;
			by("detailAppUid").textContent = uidText(current) + (current.system ? " · " + t("系统应用") : "");
			enable.checked = draft().enabled;
			filter.checked = draft().filterDirectory;
			updatePathError();
			paintPaths();
			paintDraft();
		}

		function showDetail(app) {
			previousScroll = document.scrollingElement?.scrollTop || 0;
			current = app;
			selectedKey = draftKey(app);
			if (!editing.has(selectedKey)) editing.set(selectedKey, copyDraft(saved.get(selectedKey) ?? emptyDraft()));
			input.value = "";
			pathError = "";
			setIcon(by("detailAppIcon"), app.pkg);
			paintDetail();
			navigate("appDetail");
			appName.focus({ preventScroll: true });
		}

		by("previewLegacyMigrationBtn").addEventListener("click", () => { previewRequested = true; renderLegacyPreview(); });
		by("exportAppDraftsBtn").addEventListener("click", exportDrafts);
		by("importAppDraftsBtn").addEventListener("click", importDrafts);
		by("appDraftBackupInput").addEventListener("input", event => event.target.removeAttribute("aria-invalid"));
		by("directoryBackBtn").addEventListener("click", () => {
			navigate("apps");
			const prev = [...list.querySelectorAll("button")].find(button => button.dataset.directoryKey === selectedKey);
			(prev || search).focus({ preventScroll: true });
			document.scrollingElement?.scrollTo?.(0, previousScroll);
		});
		by("openLegacyRulesBtn").addEventListener("click", () => navigate("config"));
		by("applyProfilesBtn").addEventListener("click", () => {
			// Applying changes what the module does, so the first click only
			// arms the action and the second one within five seconds runs it.
			if (!armed) {
				armed = true;
				applyState.textContent = t("再点一次「应用到模块」确认；规则会写入模块并热重载。");
				clearTimeout(armTimer);
				armTimer = setTimeout(disarm, 5000);
				return;
			}
			disarm();
			void applySavedDrafts();
		});
		by("legacyBackBtn").addEventListener("click", () => navigate("apps"));
		search.addEventListener("input", () => { limit = pageSize; renderList(); });
		includeSystem.addEventListener("change", refresh);
		by("refreshDirectoryBtn").addEventListener("click", refresh);
		more.addEventListener("click", () => { limit += pageSize; renderList(); });
		input.addEventListener("input", () => { pathError = ""; updatePathError(); });
		enable.addEventListener("change", () => { if (current) { draft().enabled = enable.checked; paintDraft(); } });
		filter.addEventListener("change", () => { if (current) { draft().filterDirectory = filter.checked; paintDraft(); } });
		by("draftPathForm").addEventListener("submit", event => {
			event.preventDefault();
			if (!current) return;
			const path = input.value.trim();
			if (!codec.validPath(path)) pathError = "invalid";
			else if (draft().paths.includes(path)) pathError = "duplicate";
			else if (draft().paths.length >= codec.maxPaths) pathError = "full";
			else {
				pathError = "";
				draft().paths.push(path);
				input.value = "";
				paintPaths();
				paintDraft();
			}
			updatePathError();
			input.focus();
		});
		save.addEventListener("click", () => {
			if (!current || save.disabled) return;
			saved.set(selectedKey, copyDraft(draft()));
			paintDraft();
		});
		discard.addEventListener("click", () => {
			if (!current || discard.disabled) return;
			editing.set(selectedKey, copyDraft(saved.get(selectedKey) ?? emptyDraft()));
			input.value = "";
			pathError = "";
			paintDetail();
			enable.focus();
		});

		return {
			showList() { if (state === "idle") void refresh(); else renderList(); },
			refreshText() { renderList(); renderLegacyPreview(); renderBackupStatus(); if (current) paintDetail(); },
		};
	}

	window.PathMaskAppDirectory = { mount };
})();
