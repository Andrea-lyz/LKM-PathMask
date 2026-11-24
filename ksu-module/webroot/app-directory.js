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

	function mount({ t, readApps, matches, navigate, readProfiles, applyProfiles, canApplyProfiles }) {
		const by = id => document.getElementById(id);
		const codec = window.PathMaskProfileDrafts;
		if (!codec?.decodeRules || !by("directoryList") || !by("applyProfilesBtn")) return null;
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
		const applyButton = by("applyProfilesBtn");
		let stored = null;
		let applying = false;
		let armed = false;
		let armTimer = 0;
		const fromDisk = key => stored?.get(key) ?? emptyDraft();
		const lastSaved = key => saved.get(key) ?? fromDisk(key);

		function updateApplyButton() {
			const modeReady = canApplyProfiles();
			by("profileModeNotice").hidden = modeReady;
			applyButton.disabled = applying || !modeReady || !stored || !saved.size;
		}

		function disarm() {
			if (armed) applyState.textContent = "";
			armed = false;
			clearTimeout(armTimer);
			armTimer = 0;
		}

		async function loadStoredRules() {
			if (stored) return;
			try {
				const incoming = await readProfiles();
				for (const [key, value] of editing) {
					if (!saved.has(key) && equal(value, fromDisk(key)))
						editing.set(key, copyDraft(incoming.get(key) ?? emptyDraft()));
				}
				stored = incoming;
				applyState.textContent = "";
			} catch (_) {
				applyState.textContent = t("无法读取模块已有规则，不能应用草稿。可刷新后重试。");
			}
			updateApplyButton();
		}

		async function applySavedDrafts() {
			if (applyButton.disabled || typeof applyProfiles !== "function") return;
			const changes = new Map([...saved].filter(([key]) => !key.startsWith("?:")));
			const skipped = saved.size - changes.size;
			if (!changes.size) {
				applyState.textContent = t("没有可应用的草稿；无法确定 Android 用户的草稿未写入。");
				return;
			}
			applying = true;
			updateApplyButton();
			applyState.textContent = t("正在应用逐应用规则...");
			try {
				const result = await applyProfiles(changes, stored);
				const previous = stored;
				stored = result.profiles;
				for (const [key, value] of changes) {
					if (saved.has(key) && equal(saved.get(key), value)) saved.delete(key);
				}
				for (const [key, value] of editing) {
					if (!saved.has(key) && equal(value, previous.get(key) ?? emptyDraft()))
						editing.set(key, copyDraft(fromDisk(key)));
				}
				applyState.textContent = skipped
					? t("已确认 {0} 条逐应用路径；{1} 个草稿的 Android 用户未知，未写入。", [result.pathCount, skipped])
					: t("内核已确认 {0} 条逐应用路径，配置已保存。", [result.pathCount]);
				renderList();
				if (current) paintDetail();
			} catch (error) {
				applyState.textContent = t("应用失败：{0}", [error && error.message ? error.message : String(error)]);
			} finally {
				applying = false;
				updateApplyButton();
			}
		}
		const uidText = app => "UID " + (app.uid || t("未知"));
		const draft = () => editing.get(selectedKey);

		function hasDraft(key) {
			return saved.has(key) || editing.has(key) && !equal(editing.get(key), fromDisk(key));
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
			else if (stored?.has(key)) meta.append(node("span", "directoryBadge", t("模块已有规则")));
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
			updateApplyButton();
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
				const [apps] = await Promise.all([readApps(includeSystem.checked), loadStoredRules()]);
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

		function updatePathError() {
			input.setAttribute("aria-invalid", String(!!pathError));
			errorNode.hidden = !pathError;
			errorNode.textContent = pathError === "duplicate" ? t("这条路径已经添加。")
				: pathError === "invalid" ? t("请输入不超过 255 字节、且不含逗号或分号的非根绝对路径。")
				: pathError === "full" ? t("此草稿的路径数量已达上限。") : "";
		}

		function paintDraft() {
			const value = draft();
			const dirty = !equal(value, lastSaved(selectedKey));
			save.disabled = discard.disabled = !dirty;
			by("draftSaveState").textContent = dirty ? t("草稿有未保存的更改") : saved.has(selectedKey) ? t("已保存草稿（未应用）")
				: stored?.has(selectedKey) ? t("模块已有规则") : "";
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
			disarm();
			previousScroll = document.scrollingElement?.scrollTop || 0;
			current = app;
			selectedKey = draftKey(app);
			if (!editing.has(selectedKey)) editing.set(selectedKey, copyDraft(lastSaved(selectedKey)));
			input.value = "";
			pathError = "";
			setIcon(by("detailAppIcon"), app.pkg);
			paintDetail();
			navigate("appDetail");
			appName.focus({ preventScroll: true });
		}

		by("directoryBackBtn").addEventListener("click", () => {
			navigate("apps");
			const prev = [...list.querySelectorAll("button")].find(button => button.dataset.directoryKey === selectedKey);
			(prev || search).focus({ preventScroll: true });
			document.scrollingElement?.scrollTo?.(0, previousScroll);
		});
		applyButton.addEventListener("click", () => {
			if (applyButton.disabled) return;
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
			disarm();
			if (equal(draft(), fromDisk(selectedKey))) saved.delete(selectedKey);
			else saved.set(selectedKey, copyDraft(draft()));
			updateApplyButton();
			paintDraft();
		});
		discard.addEventListener("click", () => {
			if (!current || discard.disabled) return;
			editing.set(selectedKey, copyDraft(lastSaved(selectedKey)));
			input.value = "";
			pathError = "";
			paintDetail();
			enable.focus();
		});

		updateApplyButton();
		return {
			showList() { if (state === "idle") void refresh(); else renderList(); },
			refreshText() { renderList(); if (current) paintDetail(); },
		};
	}

	window.PathMaskAppDirectory = { mount, setIcon };
})();
