/*
 * Diagnostics view: verdict, health checks, logs and report.
 *
 * The heavy collection lives in js/domain/diagnostics.js. This view only
 * decides when to ask for it, maps domain levels onto the UI, and keeps
 * the log/report panes in sync.
 */
(function (root, factory) {
	const isNode = typeof module === "object" && module.exports;
	const format = isNode ? require("../../core/format.js") : root.PathMask.format;
	const api = factory(root, format);
	if (isNode) module.exports = api;
	if (root) {
		root.PathMask = root.PathMask || {};
		root.PathMask.views = root.PathMask.views || {};
		root.PathMask.views.diagnostics = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, format) {
	"use strict";

	const DIAG_HISTORY_DIR = "/data/adb/pathmask/diag-history";
	const LEGACY_DIAG_HISTORY_DIR = "/data/adb/pathmask/diagnostics";
	const DIAG_HISTORY_KEEP = 5;

	function levelForVerdict(level) {
		if (level === "bad") return "danger";
		if (level === "ok" || level === "warn" || level === "info") return level;
		return "info";
	}

	function check(level, title, detail) {
		return { level, title, detail };
	}

	function buildHealthChecks(facts, t = (source) => source) {
		const checks = [];
		if (facts.ksuDisabled) {
			checks.push(check("danger", t("模块被禁用"), t("存在 disable 或 remove 标记，KernelSU 不会加载这个模块。")));
		} else if (!facts.moduleLoaded) {
			checks.push(check(
				"danger",
				t("模块未加载"),
				facts.hasBootState
					? t("boot_state：{0}。", [facts.bootStateName || "?"])
					: t("service.sh 没有执行，或模块加载失败。"),
			));
		} else {
			checks.push(check("ok", t("模块已加载"), facts.moduleLine || t("已在内核中运行。")));
		}

		if (facts.koMissing) {
			checks.push(check("danger", t("模块文件缺失"), t("找不到 pathmask.ko，重新刷入模块。")));
		}
		if (facts.procguardKoMissing) {
			checks.push(check("danger", t("procguard.ko 缺失"), t("模块包缺少 procguard.ko，隔离防护不可用。")));
		}
		if (facts.failCount >= 3) {
			checks.push(check("danger", t("连续加载失败"), t("失败计数为 {0}；检查内核版本和 dmesg。", [facts.failCount])));
		}

		if (facts.hasBootState) {
			if (facts.bootStateName === "loaded" && facts.moduleLoaded) {
				checks.push(check("ok", t("开机流程完成"), `state=loaded${facts.bootStateDetail ? ` · ${facts.bootStateDetail}` : ""}`));
			} else if (facts.bootStateName === "paused") {
				checks.push(check("info", t("开机流程已暂停"), t("隐藏路径当前不会生效。")));
			} else if (facts.bootStateName === "failed" || String(facts.bootStateName || "").startsWith("failed-")) {
				checks.push(check("danger", t("开机流程失败"), `state=${facts.bootStateName}${facts.bootStateDetail ? ` · ${facts.bootStateDetail}` : ""}`));
			} else {
				checks.push(check("warn", t("开机流程未完成"), `state=${facts.bootStateName || "?"}${facts.bootStateDetail ? ` · ${facts.bootStateDetail}` : ""}`));
			}
		} else if (!facts.moduleLoaded) {
			checks.push(check("danger", t("缺少 boot_state"), t("service.sh 可能没有被 KernelSU 执行，检查模块状态和开机日志。")));
		}

		if (facts.anyStale) {
			const which = [];
			if (facts.stale && facts.stale.scope) which.push("scope_mode");
			if (facts.stale && facts.stale.enableSyscallHooks) which.push("enable_syscall_hooks");
			if (facts.stale && facts.stale.syscallHooks) which.push("syscall_hooks");
			if (facts.stale && facts.stale.denyUids) which.push("deny_uids");
			checks.push(check("warn", t("配置未热重载"), t("sysfs 运行参数和 conf 不一致：{0}。", [which.join(", ")])));
		}

		if (facts.confTargetCount === 0) {
			checks.push(check("warn", t("没有目标路径"), t("target_path.conf 为空，隐藏不会发生。")));
		} else if (facts.sysResolvedCount >= 0 && facts.sysResolvedCount < facts.confTargetCount) {
			checks.push(check(
				"warn",
				t("目标路径未全部解析"),
				t("配置 {0} 条，运行中解析到 {1} 条。通配路径可能本来就没有匹配。", [facts.confTargetCount, facts.sysResolvedCount]),
			));
		} else if (facts.sysResolvedCount >= 0) {
			checks.push(check("ok", t("目标路径已解析"), t("{0}/{1} 条路径命中。", [facts.sysResolvedCount, facts.confTargetCount])));
		}

		if (facts.unresolvedDenyPackages && facts.unresolvedDenyPackages.length) {
			checks.push(check(
				"warn",
				t("有应用未解析为 UID"),
				t("这些包名当前找不到 UID：{0}。", [facts.unresolvedDenyPackages.join(", ")]),
			));
		}
		if (facts.orphanDenyUids && facts.orphanDenyUids.length) {
			checks.push(check(
				"warn",
				t("有 UID 不属于已选应用"),
				t("可能是应用被卸载或包名变化：{0}。", [facts.orphanDenyUids.join(", ")]),
			));
		}

		if (facts.dmesgState && !facts.dmesgState.available) {
			checks.push(check("warn", t("dmesg 不可读"), facts.dmesgState.reason || t("无法读取内核日志。")));
		} else if (facts.dmesgSummary && facts.dmesgSummary.errorLines && facts.dmesgSummary.errorLines.length) {
			checks.push(check("danger", t("内核日志有错误"), facts.dmesgSummary.errorLines[0]));
		} else {
			checks.push(check("ok", t("内核日志正常"), t("没有发现模块加载或符号解析错误。")));
		}

		if (facts.procguard === true) {
			if (facts.procguardLoaded) {
				checks.push(check("ok", t("procguard 已加载"), t("隔离进程保护正在运行。")));
			} else {
				checks.push(check("warn", t("procguard 未加载"), t("配置已启用，但模块没有出现在 /proc/modules。")));
			}
		}

		return checks;
	}

	function render(app) {
		const state = app.getState();
		const diagnostics = state.diagnostics;
		const runButton = document.getElementById("runDiagnosticBtn");
		if (runButton) {
			runButton.onclick = () => run(app);
			runButton.disabled = !!state.diagnosing;
			runButton.textContent = state.diagnosing
				? app.i18n.t("正在诊断...")
				: app.i18n.t("重新诊断");
		}
		const emptyButton = document.getElementById("emptyDiagnoseBtn");
		if (emptyButton) emptyButton.onclick = () => run(app);
		for (const id of ["copyReportBtn", "copyReportBtn2"]) {
			const button = document.getElementById(id);
			if (!button) continue;
			button.disabled = !(diagnostics && diagnostics.report);
			button.onclick = () => copyReport(app);
		}
		const history = document.getElementById("historyBtn");
		if (history) history.onclick = () => openHistory(app);

		renderVerdict(app, diagnostics);
		renderLogs(app);
		renderReport(app, diagnostics);
	}

	function renderVerdict(app, diagnostics) {
		const state = app.getState();
		const box = document.getElementById("verdictBox");
		const list = document.getElementById("healthList");
		const empty = document.getElementById("diagEmpty");
		const meta = document.getElementById("diagMeta");
		if (!box || !list || !empty) return;

		if (!diagnostics || !diagnostics.verdict || !diagnostics.facts) {
			box.hidden = true;
			box.textContent = "";
			list.textContent = "";
			empty.hidden = false;
			if (meta) meta.textContent = state.diagError || app.i18n.t("还没有运行诊断。");
			return;
		}

		const verdict = diagnostics.verdict;
		const level = levelForVerdict(verdict.level);
		box.hidden = false;
		box.dataset.level = level;
		box.textContent = "";
		const title = document.createElement("div");
		title.className = "verdictTitle";
		title.textContent = verdict.headline || app.i18n.t("诊断完成");
		const detail = document.createElement("div");
		detail.className = "verdictDetail";
		const suggestions = Array.isArray(verdict.suggestions) ? verdict.suggestions : [];
		detail.textContent = suggestions.length ? suggestions.join(" ") : app.i18n.t("没有额外建议。");
		box.append(title, detail);

		list.textContent = "";
		for (const item of buildHealthChecks(diagnostics.facts, app.i18n.t)) {
			const row = document.createElement("li");
			row.className = "healthItem";
			row.dataset.level = item.level;
			const dot = document.createElement("span");
			dot.className = "healthDot";
			const text = document.createElement("span");
			text.className = "healthText";
			const heading = document.createElement("strong");
			heading.textContent = item.title;
			const body = document.createElement("span");
			body.textContent = item.detail || "";
			text.append(heading, body);
			row.append(dot, text);
			list.append(row);
		}

		empty.hidden = true;
		if (meta) {
			if (state.diagError) {
				meta.textContent = state.diagError;
			} else {
				const when = diagnostics.timestamp
					? new Date(diagnostics.timestamp * 1000).toLocaleString()
					: new Date().toLocaleString();
				const label = level === "ok" ? app.i18n.t("通过")
					: level === "warn" ? app.i18n.t("有提醒")
						: level === "danger" ? app.i18n.t("有问题")
							: app.i18n.t("提示");
				meta.textContent = app.i18n.t("{0} · {1}", [when, label]);
			}
		}
	}

	function renderLogs(app) {
		const state = app.getState();
		const output = document.getElementById("logOutput");
		const info = document.getElementById("logPageInfo");
		const box = document.querySelector("#logsSection .logBox");
		if (!output) return;
		const pages = format.paginate(app.getLogsFor(state.logTab));
		if (state.logPage >= pages.length) state.logPage = pages.length - 1;
		if (state.logPage < 0) state.logPage = 0;
		output.textContent = pages[state.logPage] || app.i18n.t("(没有日志)");
		if (info) info.textContent = `${state.logPage + 1} / ${pages.length}`;
		if (box) box.classList.toggle("wrap", !!state.logWrap);
		const wrap = document.getElementById("logWrapInput");
		if (wrap) wrap.checked = !!state.logWrap;
		for (const button of document.querySelectorAll("#logTabs [data-log]")) {
			const active = button.dataset.log === state.logTab;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		const prev = document.getElementById("prevLogBtn");
		const next = document.getElementById("nextLogBtn");
		if (prev) {
			prev.disabled = state.logPage <= 0;
			prev.onclick = () => {
				if (state.logPage <= 0) return;
				state.logPage -= 1;
				renderLogs(app);
			};
		}
		if (next) {
			next.disabled = state.logPage >= pages.length - 1;
			next.onclick = () => {
				if (state.logPage >= pages.length - 1) return;
				state.logPage += 1;
				renderLogs(app);
			};
		}
	}

	function renderReport(app, diagnostics) {
		const report = document.getElementById("reportOutput");
		if (report) report.value = diagnostics && diagnostics.report ? diagnostics.report : "";
	}

	async function run(app, options = {}) {
		const state = app.getState();
		if (state.diagnosing) return;
		const silent = options.silent === true;
		state.diagnosing = true;
		state.diagError = "";
		render(app);
		const meta = document.getElementById("diagMeta");
		if (meta) meta.textContent = app.i18n.t("正在读取模块、配置和内核状态...");
		try {
			const result = await root.PathMask.diagnostics.collectSnapshot();
			result.timestamp = Math.floor(Date.now() / 1000);
			result.level = levelForVerdict(result.verdict.level);
			result.title = result.verdict.headline;
			result.detail = (result.verdict.suggestions || []).join(" ");
			app.setDiagnostics(result);
			app.setLogs({
				status: result.snapshot.statusLog || "",
				config: result.snapshot.configLog || "",
				kernel: result.facts.dmesgState && result.facts.dmesgState.available
					? result.facts.dmesgRaw || ""
					: (result.facts.dmesgState ? result.facts.dmesgState.reason : ""),
				script: result.snapshot.scriptLog || result.snapshot.scriptLogReason || "",
			});
			state.logPage = 0;
			app.renderAll();
			if (options.saveHistory !== false) await saveHistory(app, result.report);
			if (!silent) {
				app.toast(levelForVerdict(result.verdict.level) === "danger"
					? app.i18n.t("诊断完成，但发现问题")
					: app.i18n.t("诊断完成"));
			}
		} catch (error) {
			state.diagError = error.message || app.i18n.t("诊断失败");
			if (!silent) app.toast(state.diagError, "danger");
		} finally {
			state.diagnosing = false;
			render(app);
		}
	}

	async function copyText(app, text, successMessage) {
		if (!text) {
			app.toast(app.i18n.t("还没有可复制的报告"));
			return;
		}
		try {
			if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
				try {
					await root.navigator.clipboard.writeText(text);
				} catch (clipboardError) {
					legacyCopy(text);
				}
			} else {
				legacyCopy(text);
			}
			app.toast(successMessage || app.i18n.t("报告已复制"));
		} catch (error) {
			app.toast(app.i18n.t("复制失败，请长按报告手动复制"), "danger");
		}
	}

	async function copyReport(app) {
		const diagnostics = app.getState().diagnostics;
		const text = diagnostics && diagnostics.report ? diagnostics.report : "";
		await copyText(app, text, app.i18n.t("报告已复制"));
	}

	function legacyCopy(text) {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const copied = typeof document.execCommand === "function" && document.execCommand("copy");
		area.remove();
		if (!copied) throw new Error("copy command failed");
	}

	async function saveHistory(app, report) {
		if (!report || !app.bridge) return;
		const epoch = Math.floor(Date.now() / 1000);
		const marker = `PMHIST_EOF_${epoch}_${Math.random().toString(36).slice(2, 8)}`;
		const path = `${DIAG_HISTORY_DIR}/diag-${epoch}.txt`;
		const command = [
			`mkdir -p '${DIAG_HISTORY_DIR}' 2>/dev/null || true`,
			`chmod 0700 '${DIAG_HISTORY_DIR}' 2>/dev/null || true`,
			`cat > '${path}' <<'${marker}'`,
			report,
			marker,
			`chmod 0600 '${path}' 2>/dev/null || true`,
			`ls -1t '${DIAG_HISTORY_DIR}'/diag-*.txt 2>/dev/null | awk -v keep=${DIAG_HISTORY_KEEP} 'NR>keep' | xargs rm -f 2>/dev/null || true`,
			"true",
		].join("\n");
		try {
			await app.bridge.execShell(command);
		} catch (error) {
			// History is a convenience, never a reason to fail a diagnosis.
		}
	}

	function historyLabel(file) {
		const match = String(file || "").match(/diag-(\d+)\.txt$/);
		if (!match) return String(file || "").split("/").pop();
		const date = new Date(Number(match[1]) * 1000);
		return Number.isNaN(date.getTime()) ? String(file).split("/").pop() : date.toLocaleString();
	}

	async function openHistory(app) {
		if (!app.bridge) return;
		let output = "";
		try {
			output = await app.bridge.execShell(
				`ls -1t '${DIAG_HISTORY_DIR}'/diag-*.txt '${LEGACY_DIAG_HISTORY_DIR}'/diag-*.txt 2>/dev/null || true`,
			);
		} catch (error) {
			app.toast(error.message || app.i18n.t("读取历史失败"), "danger");
			return;
		}
		const files = [...new Set(String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
			.sort((a, b) => {
				const ea = Number((a.match(/diag-(\d+)\.txt$/) || [])[1] || 0);
				const eb = Number((b.match(/diag-(\d+)\.txt$/) || [])[1] || 0);
				return eb - ea;
			});
		const content = document.createElement("div");
		content.className = "sheetForm";
		if (!files.length) {
			const note = document.createElement("p");
			note.className = "sheetNote";
			note.textContent = app.i18n.t("还没有历史诊断。运行一次诊断后会自动保存。");
			content.append(note);
		} else {
			const list = document.createElement("div");
			list.className = "choiceGrid compact";
			for (const file of files) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "button ghost";
				button.style.justifyContent = "flex-start";
				button.textContent = historyLabel(file);
				button.title = file;
				button.onclick = async () => {
					try {
						const text = await app.bridge.execShell(`cat '${file}' 2>/dev/null || true`);
						const wrapper = document.createElement("div");
						wrapper.className = "sheetForm";
						const area = document.createElement("textarea");
						area.className = "monoBox";
						area.style.minHeight = "50vh";
						area.readOnly = true;
						area.value = text;
						const copy = document.createElement("button");
						copy.type = "button";
						copy.className = "button ghost";
						copy.textContent = app.i18n.t("复制");
						copy.onclick = () => copyText(app, text, app.i18n.t("已复制"));
						wrapper.append(area, copy);
						app.openSheet({ title: historyLabel(file), content: wrapper, hideActions: true });
					} catch (error2) {
						app.toast(error2.message || app.i18n.t("读取历史失败"), "danger");
					}
				};
				list.append(button);
			}
			content.append(list);
		}
		app.openSheet({ title: app.i18n.t("历史诊断"), content, hideActions: true });
	}

	return {
		buildHealthChecks,
		copyReport,
		levelForVerdict,
		openHistory,
		render,
		run,
	};
});
