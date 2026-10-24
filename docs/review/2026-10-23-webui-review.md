# WebUI code review — v2.8.3

Reviewed: `ksu-module/webroot/{index.html,app.js,style.css}` (5,262 lines) as of
commit `4adf552`. Everything below was reproduced against the real files, not
read off a diff, and every fix is covered by a check in `tools/tests/webui/`.

The WebUI is in good shape structurally: no `innerHTML` on untrusted data
(anything device-derived goes through `textContent` or a textarea `value`), all
shell interpolation goes through `shellQuote()`, the i18n scheme degrades to
Chinese instead of blank labels, and the comments explain *why* rather than
*what*. The problems found are concentrated in three places: state that gets
frozen at load time, layout offsets that are guessed instead of measured, and
accessibility semantics that were never wired up.

## Severity 1 — broken behaviour a user hits

**1. A lost bridge callback locks the UI permanently.** `execShell()` could only
be settled by the callback KernelSU invokes. If the manager never answered —
wedged root shell, service killed mid-command, WebView that lost the
JavascriptInterface — the promise stayed pending forever. `runAction()` releases
`busy` in its `finally`, so `busy` stayed `true` and every button in
`actionButtons` stayed disabled for the life of the page, with no recovery short
of leaving and reopening the WebUI. Fixed with a 90s watchdog that clears the
timer and the global through a single `settle()` exit point, reports a
translated timeout, and lets `runAction`'s `finally` release the lock. 90s is
past the slowest legitimate command here (a hot reload runs `service.sh` with a
5s wait budget plus `rmmod` and `dmesg`).

**2. Opening a dialog never moved focus into it.** `openModal()` did
`modal.querySelector("[data-modal-close]")` and focused the result. In all three
dialogs the first element carrying that attribute is the full-screen
`.modalBackdrop` div, which is not focusable, so `focus()` was a no-op and the
dialog opened with focus still on the control behind it. Combined with
**3** below, a keyboard user could open a modal and then Tab straight out of it.
Fixed by focusing the first element matching the focusable selector.

**3. Modals did not trap or restore focus.** Tab could leave the dialog into the
page behind it (which `aria-modal="true"` tells a screen reader to ignore), and
on close focus fell back to `<body>`, so the next Tab restarted at the top of
the page. Fixed with `trapModalFocus()` on Tab/Shift+Tab and focus restoration
in `closeModal()`.

**4. The 系统应用 toggle did nothing.** `#showSystemInput` had no event listener
at all — it only took effect if the user also pressed 加载, which reads as a
broken checkbox. Now reloads through the busy lock.

**5. Ticking an app threw the list away.** The checkbox `change` handler called
`renderApps()`, which clears the container and re-sorts selected rows to the
top. The row the user had just ticked moved away from the pointer and
`#appList` scrolled back to 0. Selecting several apps in a row meant hunting for
each one again. Now the handler toggles the row's class in place; the sort still
happens, but only on a real re-render (search, scope switch, refresh).

**6. The write-policy toast was frozen in the boot language.**
`WRITE_POLICY_LABELS` was a module-level object built by calling `t()` at parse
time. A user who switched to English then changed the policy got
`Write policy switched to 伪装不存在`. Confirmed by running the original code
under the harness. Fixed by storing keys and translating at the point of use.

**7. `hide_dirents` disagreed with the kernel.** `refreshConfig()` read it as
`(hideText.trim() || "1") !== "0"` while every other boolean conf goes through
`parseBoolish()`, which exists precisely to mirror service.sh's accept-list. A
hand-edited `off`, `no` or `false` — all of which service.sh and the kernel
treat as disabled — displayed as enabled.

**8. The inline error trap reported missing images as script errors.**
index.html's last-resort handler is registered in the capture phase, which is
also how failed resource loads reach `window`. Those events carry no `message`,
only a `filename` pointing at the asset, so a missing or corrupt `PY_QR.png`
overwrote an otherwise healthy status line with `脚本错误：脚本错误 @ PY_QR.png:0`.
Now guarded on `e.message`.

**9. app.js's own trap could throw inside itself.** Both handlers called `t()`,
which reads `uiLang` (a `let`) and `EN_TEXT` (a `const`) declared hundreds of
lines further down. An error raised before those initialisers run makes `t()`
throw a TDZ `ReferenceError` *inside the trap* — the one window where the trap is
most likely to fire, and the failure it exists to report is the one that then
stays invisible. Replaced with `trapText()`, which degrades to the Chinese
source.

## Found after the initial pass

**25. 刷新 on the Mask tab popped the IME over the hidden-path list.**
`addPathRow()` ended with an unconditional `input.focus()`. That is right for
添加, where the caret should be waiting in the new empty field, but
`renderPaths()` calls `addPathRow()` once per configured path on every config
read, so each row stole focus in turn and the last path input kept it. On an
Android WebView a programmatically focused `<input type="text">` raises the soft
keyboard — hence 刷新 opening the IME on the last 隐藏路径 field. The same rebuild
runs on page load and after 保存配置 / 恢复默认配置 / toggling procguard, so all of
those were affected. Focus is now opt-in and only 添加 asks for it.

## Severity 2 — layout that does not match the rendered page

**10. The sticky tab offset was a guess that was already wrong.** `.tabs` used
`top: 67px`. The top bar measures ~73px at 1× font scale
(16 padding + 25.3 h1 + 4 margin + 15.6 status + 12 padding), so the tab row sat
~6px under the top bar, which has the higher `z-index`. It got worse whenever
`#statusText` wrapped — which is exactly what a long bridge or boot error does,
and the whole reason that element exists is to surface long errors.
`body { padding-bottom: 92px }` was the same kind of guess against a ~68px
footer, and in English at a large system font scale the three-column footer can
grow past it and cover the last panel's controls. Both offsets are now measured
by `observeChromeOffsets()` and published as `--topbar-h` / `--actions-h`, with a
`ResizeObserver` and a `resize` fallback for WebViews without it.

**11. Footer buttons could not shrink.** Grid children default to
`min-width: auto`, so a long label overflowed instead of wrapping. Added
`min-width: 0` plus `overflow-wrap`.

**12. The focus indicator on history items was deleted.**
`.historyItem:hover, .historyItem:focus { outline: none }` removed the only
indication of which snapshot was focused on an element that is keyboard
operable (`tabIndex=0` with an Enter/Space handler). The hover wash is kept; the
outline suppression is gone, and a single `:focus-visible` rule now covers the
page — the WebView default is easy to lose against the `Highlight`-coloured
active tab and the tinted panel backgrounds.

## Severity 3 — accessibility semantics

**13. The tab strip had no ARIA at all.** Five buttons with an `.active` class:
no `role=tablist`/`tab`/`tabpanel`, no `aria-selected`, no `aria-controls`, no
roving tabindex, no arrow-key navigation. Nothing announced which panel was
open, and a keyboard user had to Tab through all five tabs to get past the
header. Added, with the five tabs wrapped in a `.tabGroup` so the tablist
contains only tabs — the language switch has to stay on that row (see the
existing `.langSwitch` comment) but it is not a tab, and a non-tab child inside
`role=tablist` breaks the semantics readers rely on.

**14. The log tabs are not tabs.** Four buttons selecting which log a *single*
viewer shows is a group of toggles, not a tablist — each tab would need its own
panel. Modelled as `role=group` with `aria-pressed`.

**15. Toasts were silent.** `#toast` had no live region, so save/copy/error
feedback was never announced. Now `role="status" aria-live="polite"`. The
app-list result count is announced the same way.

## Severity 4 — performance and correctness of the app list

**16. `pm list packages` instead of the native API.** KernelSU injects
`listPackages(type)` (`"user"` | `"system"` | `"all"`) and `getPackagesInfo()`
returning `{packageName, appLabel, isSystem, uid, versionName}` alongside `exec`
— verified against the `kernelsu` npm package and `tiann/KernelSU/js/README.md`.
Using it removes a `pm` subprocess (seconds on some devices, and the usual
reason 加载 looks hung), makes the 系统应用 toggle filter on the manager's own
`isSystem` rather than on `pm -3` (which disagrees for preinstalled and
updated-system apps), and lets rows show a human-readable label. The shell path
stays as a fallback for managers that only inject `exec`.

**17. Unbounded row construction.** Every keystroke in the search box rebuilt
one DOM node per matching app and appended each to the live container, which
makes the engine re-run layout per row. Now a `DocumentFragment`, one append, a
200-row render cap with a "showing N of M" line, and the scroll offset is
carried across re-renders.

**18. Search only matched the package name.** Now also matches the app label and
the UID column.

## Severity 5 — report and translation integrity

**19. Diagnostic strings were translated once and stored.** `computeVerdict()`
ran at gather time and its headline and suggestions were cached in the snapshot,
along with `dmesgState.reason`, `taintInfo.pretty`, `bootStateAgeStr` and
`kernelLog`. Switching language re-rendered the panel from those cached strings,
so the verdict box stayed in the old language — and it was not re-rendered at
all, because `refreshRenderedText()` never called `renderVerdictPanel()`. Facts
are now language-neutral (a bitmask, a `kind` discriminator, an epoch) and the
wording is produced at render time by `computeVerdict()`, `dmesgReason()`,
`taintPretty()` and `kernelLogText()`, all re-run on a language switch.

**20. `refreshRenderedText()` bailed out entirely on a failed read.** Its guard
was `if (!lastSnapshot.targetText) return`, so if the config read had failed a
language switch left the page half-translated with no way to finish it. Now only
the parts that would invent a state (a status line claiming the module is not
loaded, a procguard line claiming the `.ko` is missing) wait for a snapshot.

**21. The report's columns were ragged in Chinese.** `fmtFactRow()` used
`String.padEnd(14)`, which counts code units while a CJK character occupies two
cells in the monospace font the report is read in. Every Chinese label
overflowed its column by roughly its own length. Now padded on display width.

**22. `t` was shadowed.** `buildDmesgSection()` had
`for (const t of summary.targetLines)` inside the file whose translation
function is named `t`. Harmless today, a confusing `TypeError` for the next
person who adds a translated string in that loop.

## Duplication removed

**23.** `saveConfig()` and `reloadModule()` held byte-identical 13-line
sequences writing every conf — the mechanism by which a newly added option gets
written by one path and silently dropped by the other. Extracted to
`persistConfigFiles()`.

**24.** `applyWritePolicy()` and `reloadModule()` held byte-identical copies of a
~400-character shell string. They must stay identical (`write_op_policy` is
itself an insmod parameter, so switching it needs the same full reload as any
other change), and two copies of a string that long drift. Extracted to
`reloadCommand()`, with the load-bearing environment overrides documented.

## Verification

`tools/tests/webui/` runs in CI via `.github/workflows/webui.yml`, which
`build-lkm.yml` now calls as a release gate.

`i18n.test.mjs` extracts exactly the strings the runtime looks up — markup
captured through `data-i18n*` using the same trim rules as `applyCaptured()`,
plus every static `t()` literal — and fails on any with no `EN_TEXT` entry. It
also fails the other way, on keys whose Chinese source appears nowhere in the
shipped files; that is what caught the three keys orphaned by fix **9**. It
found no missing translations in the shipped strings. Six keys are exempted by
hand as language-neutral templates (`"{0}{1}"`, `"  {0} -> {1}"`,
`"procguard.ko: {0}"` and similar) whose substituted parts are translated at
their own call sites; the exemption list has to be reviewed to grow, and an
exemption that no longer matches a call site is itself a failure. Extraction
needs a real JS scanner, not a regex: `shellQuote()` contains `/'/g` inside a
template substitution, and misreading that one slash as division makes the
scanner treat the quote inside the regex as a string start and consume the rest
of the file — which is how the first version of this test silently saw 20 call
sites instead of 339.

`smoke.test.mjs` boots the real `index.html` and the real `app.js` in jsdom
against a stubbed `window.ksu` and drives the UI: 15 checks covering boot,
config population, focus after a refresh, tab and arrow-key semantics, the
native and shell app-list paths, in-place toggling, search, modal focus,
language switching, the write-policy toast, and the exec watchdog.

Both suites were run against the **original** files to confirm they are
regression guards rather than tautologies. 12 of 15 checks fail there for the
right reasons — including `Write policy switched to 伪装不存在` for **6**, a
rebuilt row node for **5**, focus landing on a path `<INPUT>` for **25**, focus
staying behind the dialog for **2**, and `checked=true` against a hand-edited
`off` for **7**. The three that pass on both (boot, config population, `pm`
fallback) are the baseline that proves the harness itself is sound. The
dead-key check was separately confirmed non-vacuous by injecting a key that
appears nowhere else.

## Deliberately not changed

The 中 / EN switch staying in the tab row rather than the top bar is documented
in CSS and correct; the markup change wraps the tabs without moving it. The
custom DOM toast is kept over `ksu.toast()` because it is styled, wraps long
device paths, and is translatable. `ksu://icon/{package}` app icons are
available through the same native API and would be a genuine improvement, but
they need `onerror` fallbacks and a wider row, so they are left as a follow-up
rather than bundled into a correctness pass. Modal background inertness
(`inert` / `aria-hidden` on the page behind the dialog) is not implemented; the
focus trap plus `aria-modal` covers the keyboard and screen-reader paths. Log
tab *contents* that are raw shell output are not re-translated on a language
switch because there is nothing to translate — only the two generated fallback
lines are, and those now are.

The two remaining duplication risks are worth naming: the `data-i18n-html`
scheme keys off the exact Chinese source including inline `<code>` markup, so
reflowing a hint in the markup breaks its translation silently — this is now a
CI failure rather than a surprise. And arrow-key tab navigation does not swap
Left/Right for RTL, which is correct for the two supported locales and wrong the
moment a third is added.
