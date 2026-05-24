# PathMask 2.3.3

## 解决了什么

- **重构诊断报告**。把以前那种"四段 raw stdout 拼起来、用户复制完一脸懵、开发者收到只能再问一轮"的诊断换成结构化版本：

  - 顶部 **「结论」**一行话直说当前状态 + 1-3 条具体下一步建议；WebUI 诊断页打开自动出现绿/黄/红/蓝彩色提示框（不用再手动点「生成诊断」），开机阶段从 waiting 走到终态时也会自动重跑一次。
  - **「关键事实」**段每行带 ✓ ⚠ ✗ · 状态符号：模块加载、ko 文件 sha1、KSU 启用、开机阶段（含「多久前」）、失败计数、路径解析数 vs 配置数、hook 实战命中状态、跳过的 syscall 列表、**包名→UID 反查**（用 service.sh 同样的三段策略 packages.list / pm / stat data dir 逐个解析 deny_packages.conf 里的包名）、stale 配置告警（conf 改了没热重载）、sysfs 孤立 UID、其他 LKM 数量。
  - **「内核环境」**段：内核版本、KMI、OEM 后缀（自动识别 abogki / oneplus / oxygen / coloros / miui 等；模块工作正常时降级为 info，仅在加载失败 + dmesg 见 CRC 错误时升 ⚠）、page size、SELinux、解码后的内核污染位（不再是裸数字 4608，而是 `4608 = W (warning) + O (out-of-tree, e.g. PathMask itself)`）、dmesg 是否可读、内核拒绝信号专门一行（disagrees about version of symbol / Unknown symbol 等关键词命中即标红）。
  - **dmesg 段**从 80 行 raw 改成结构化分组：load summary / target inodes / hooked / skipped / hook fired / not found / errors，最后保留 raw 兜底。
  - **「历史诊断」**按钮：每次诊断保存到 `/data/adb/pathmask/diag-history/diag-<unix>.txt`，自动保留最近 5 份；模态框可对照之前的快照（"今天突然不工作了"对照"上次还好的"）。

- **修复 `(未生成)` 误报**。OnePlus / OxygenOS 16 默认 `dmesg_restrict=1`，旧版报告统一显示"未生成"，让用户以为是 PathMask bug。新版本会写明 `dmesg 不可读：dmesg_restrict=1（系统锁定，root WebUI shell 也无权读，部分 OnePlus / OEM ROM 默认如此）` 并明确"不是 PathMask 的问题"。
- **修复 `boot_state` 被诊断漏掉**。这个文件不在 `*.conf` glob 里，但它是 service.sh 走到哪一步的唯一信号；之前完全不打印，所以"模块没加载"类问题永远要回头让用户手动 cat。
- **修复合并 shell + 自定义分隔符在某些 OnePlus / OxygenOS WebUI bridge 上返回空 stdout** 导致 verdict 误判"模块没加载"但旁边 raw dump 明明有 `pathmask 61440 0 - Live` 的诡异问题。改为 10 个独立 `probeExec` 调用，单个失败不污染其它事实。

不影响内核模块、service.sh、conf 字段格式、sysfs 参数：诊断只是观测层。

# PathMask 2.3.2

## 解决了什么

- syscall 兜底（7 个 `__arm64_sys_*` kretprobe）从一刀切的全开 / 全关，改成可逐个勾选。WebUI 在原来的 "syscall 兜底" 总开关下方新增折叠面板「选择具体 syscall（高级）」，对 newfstatat / statx / faccessat / faccessat2 / readlinkat / openat / openat2 各一个 checkbox。
- **默认勾上 6 个，唯独不挂 `faccessat`**。这是上一版用户实测 bisect 的结论：Holmes "Abnormal Environment 04" 触发与否完全由是否 hook `__arm64_sys_faccessat` 决定，跟其他 6 个无关。最可能的解释是 Holmes 用 `access(path, F_OK)` 跑 timing fingerprint，而 bionic 在 flag=0 时刚好走 `faccessat` 而不是 `faccessat2`，access 又是这 7 个 syscall 里基线开销最低的，所以 trampoline 加的几百 ns 在百分比上最显眼。其他常规检测器（chunqiu 等）走的 stat / openat / readlink 路径全部仍被覆盖。
- 旧的 `enable_syscall_hooks=0` 默认值（v2.2.8 - v2.3.1 那一版的 Holmes 04 缓解措施）不再适用，默认改为 `1`。配合默认 6-of-7 的 syscall 子集，对绝大多数检测器既能挡住又不触 Holmes。已经在 v2.2.8 - v2.3.1 装过的用户：如果他们没改过 `enable_syscall_hooks.conf`（文件内容仍是默认的 `0` / `0\n`），开机脚本会自动迁移到新默认；改过的用户保持现状不动。

## 内核模块更新

- 新增 `syscall_hooks=` 字符串参数（逗号分隔，可用 token：`newfstatat,statx,faccessat,faccessat2,readlinkat,openat,openat2,all,none`）。`syscall_hooks` 非空时覆盖旧的 `enable_syscall_hooks` 布尔值；空时仍按旧布尔值处理（向后兼容）。
- 内核默认值（即没 insmod 参数时）是 `newfstatat,statx,faccessat2,readlinkat,openat,openat2`（6-of-7，不含 faccessat）。
- dmesg 多了一行 `pathmask: skip __arm64_sys_xxx (disabled)` 用于显示哪些 syscall 主动跳过，方便确认配置生效。

## WebUI 更新

- "增强 syscall 兜底" 文案改为中性的"syscall 兜底"，旁边加一段说明解释 6-of-7 默认值。
- 顶部"隐藏上级目录列表项"重命名为"从 ls 列表中抹掉"，并加 hint 说明它只控制 `getdents64`，跟路径行的"父级（dir:）"不是同一件事。之前用户经常误认为这两个是同一个开关。
- 新增「选择具体 syscall（高级）」折叠面板，7 个 checkbox。`faccessat` 旁标"不推荐"，鼠标悬停说明 Holmes 04 触发条件。
- 总开关关闭时，子面板里的 checkbox 自动 disabled 并整体半透明化，避免误以为它们还会生效。
- "恢复默认配置" 按钮现在写入新的 6-of-7 默认值。

# PathMask 2.3.1

## 解决了什么

- 修复重度自定义 deny_packages（200+ 包）导致的隐藏失效问题。原先内核侧 deny UID 列表上限为 128 个，超出会丢弃。如果用户的 detector 应用刚好排在第 129 个之后，`should_hide_for_current()` 对它就返回 false，所有路径在它眼中都正常存在。dmesg 里能看到 `pathmask: too many deny UIDs, skip <uid>` 警告。
- 内核侧 `MAX_DENY_UIDS` 从 128 提到 1024，`UID_LIST_LEN` insmod 参数缓冲区从 2KB 提到 8KB。1024 个 UID 可覆盖几乎所有合理场景，BSS 增量约 4KB。

## 怎么判断你是否中招了

```sh
adb shell su -c 'dmesg | grep "too many deny"' 
```
有输出说明撞到上限。升级到 v2.3.1 之后这条警告应该消失。

## 内核模块更新

本次需要重新编译 .ko，所有 7 个 KMI 都会出新版。.ko 大小可能略有增加（约 30 KB BSS）。

# PathMask 2.3.0

## 解决了什么

- 修复 v2.2.8/v2.2.9 的 update 链接问题：客户端显示 2.2.9 可更新但实际下载到的是 2.2.8 的 zip。原因是 `pathmask-latest` 滚动 release 在 tag 推送时不会被同步刷新，stale 资产留了下来。打包 workflow 现在在打 tag 时会同时更新 tag 和 `pathmask-latest`，资产永远跟最新 commit 一致。
- 简化默认配置。实测发现 `dir:/dev/???/scene_mode_category` 这一条 glob 通配既能命中 Scene 9.3+ 的随机 hash 路径，也能命中 Scene 8.x 的固定 `/dev/scene/scene_mode_category`（因为 `/dev/scene` 本身就是个目录，结构跟 9.3 同构），所以原先并列的 `any:scene:/dev/scene` 行实际上是冗余的，连带 `any:scene:` 分组也只剩一个成员失去了 OR 的意义。

## 默认配置变化

- `target_path.conf` 从 4 行精简到 3 行：
  - `/dev/cpuset/scene-daemon`
  - `dir:/dev/???/scene_mode_category`（覆盖所有 Scene 版本）
  - `/system_ext/app/SoterService`
- 升级路径：v2.2.0 - v2.2.9 各版本的「**未改动过的默认配置**」会自动迁移到新模板，对自定义过的配置不会有任何影响。要主动取回新默认，可以在 WebUI 中点「恢复默认配置」。

## 其他

- `any:<组名>:` 语法本身保留，未来仍可用于真正需要 OR 兜底的场景。
- 内核模块未变化，本次升级是配置层 + 发布管线层的精修。

# PathMask 2.2.9

## 解决了什么

- 修复 v2.2.8 全新刷入后默认配置缺失的问题。`tools/package_ksu.sh` 的硬编码默认值覆盖了模块仓库中 `ksu-module/target_path.conf` 的 4 行配置，导致 Release 包内的 `target_path.conf` 只有旧的 3 行（没有 Scene 9.3+ 的 `any:scene:dir:/dev/???/scene_mode_category`）。`deny_packages.conf` 也缺少 `me.garfieldhan.holmes`。打包脚本现在以 `ksu-module/` 中的文件为唯一真实来源，仅在调用方显式传入环境变量时才覆盖。
- 修复从旧版升级到 2.2.8 时不会获得新默认配置的问题。开机脚本会用 SHA1 识别"原封未改的旧默认值"并自动迁移到当前模板；用户自定义过的配置永远不会被改动。

## 升级行为

- 已安装 v2.2.0 - v2.2.7 且**没有改过** `target_path.conf` / `deny_packages.conf` 的用户：升到 2.2.9 后会自动获得新默认（`any:scene:` 分组路径 + `me.garfieldhan.holmes`）。
- 已经手动改过这两个文件的用户：保持原样不变。要主动获取新默认，请在 WebUI 中点「恢复默认配置」。

# PathMask 2.2.8

## 解决了什么

- 修复 Holmes「Abnormal Environment (04)」、Hunter「侧信道延迟过高」等基于系统调用时延的环境检测会误报的问题。问题由 v2.2.5 / v2.2.7 引入的多个 syscall 入口 hook 导致，hook 引入的纳秒级开销会被这些检测器统计出来。默认配置已把高频热路径上的 hook 关掉，原有的隐藏效果保留。
- 修复 Scene 9.3.0 Alpha13 升级后，原有 `/dev/scene` 检测路径变为随机父目录 `/dev/<8 字符>/scene_mode_category` 后无法继续隐藏的问题。Duck Detector 也针对此发了 PR 检测随机路径。新增动态路径语法解决这一问题。

## 新增功能

- **动态路径通配**：在 `target_path.conf` 中可以使用 `???` 通配任意一段路径（不跨 `/`）。例如 `/dev/???/scene_mode_category` 可以命中任意 `/dev/<某个目录>/scene_mode_category`。WebUI 隐藏路径列表也支持此语法。
- **隐藏父目录**：在路径前加 `dir:` 前缀，命中后隐藏的是匹配项的父目录而非匹配项本身。这能应对那些用「先确认父目录在不在再确认文件是否存在」的检测器。WebUI 路径行新增「父级」复选框对应此功能。
- **OR 分组**：路径前加 `any:<组名>:` 前缀，同名组内任一行命中即视为该组满足，配合上面两个语法可以一次写多套同效路径。开机时只要任一命中就立即加载，避免在不存在的设备上空等。WebUI 路径行新增「组」字段。
- **增强 syscall 兜底开关**：极端情况下需要更激进的隐藏覆盖时可以打开此开关；默认关闭，开启后会被多数环境检测识别为异常，不推荐开启。

## 默认配置变化

- 新增 Scene 9.3.0+ 路径默认配置，与原有 `/dev/scene` 同属 `scene` 组，老新版本 Scene 都能命中。没装 Scene 的设备也不会因此拖慢开机。
- `deny_packages.conf` 内置 `me.garfieldhan.holmes`。如果你没装 Holmes，删掉这一行即可。

## WebUI 优化

- 简化隐藏路径配置面板，新增信息按钮（ⓘ），点击后弹出说明面板介绍路径语法、`???` 通配、组、父级等用法。
- 路径行重新布局为「路径 / 组 / 父级 / 删除」四列结构，上方有列标题。
- 修复多处中文长串导致页面横向滚动、UTF-8 编码偶发解析失败、状态栏卡死无提示等问题。
- 诊断报告区分字面路径和动态路径的存在性判定，不再把 `???` 通配行误报为 MISS。

# PathMask 2.2.7

- Fix `cat /system_ext/app/SoterService/SoterService.apk` and other openat-based reads still succeeding even after v2.2.5/v2.2.6. The remaining gap was that `inode_permission`, while EXPORT_SYMBOL, also gets ThinLTO-inlined into `link_path_walk` itself, so the kretprobe attached to it covers some openers (those keep firing the "fired (first time)" log) but never gets called from the regular path walk that openat triggers. Reading a file *inside* a hidden directory therefore went straight through.
- Add `__arm64_sys_openat` and `__arm64_sys_openat2` to the kretprobe set. The same syscall-table-pointer argument as the v2.2.5 hooks applies: those entry stubs cannot be inlined. Hit detection reuses the existing `regs[1]` filename + prefix-match logic.
- Solve the openat fd-leak problem that originally kept these two syscalls off the hook list. The exit handler now invokes a kprobe-resolved `close_fd()` to release the fd that the syscall body just allocated, then overrides the return value to `-ENOENT`. If `close_fd` cannot be resolved on a particular kernel, the openat hook self-disables (entry handler returns without setting `matched`), so the open is allowed through rather than risking an fd-table leak. All other syscall hooks remain active.
- Fix WebUI health check falsely reporting "有路径当前不存在" in global scope: now that the module's own syscall hooks intercept stat() for every UID, the WebUI's `[ -e ]` probe gets `-ENOENT` for paths that the kernel actually resolved successfully -- exactly the symptom of working as designed. The WebUI now skips the user-space stat probe in `loaded + scope=global` and reads `/sys/module/pathmask/parameters/resolved_count` instead, which is set during insmod (before any hook is active) and reflects the kernel's view. The diagnostic report's "target existence" section gets the same treatment. In `deny` scope the WebUI shell (uid=0) is normally not in the deny list, so the legacy `[ -e ]` probe is still fine and stays unchanged.
- Add a read-only sysfs parameter `/sys/module/pathmask/parameters/resolved_count` exposing how many target paths the module successfully resolved at insmod time.
- Fix stat()/access()/readlink() still returning the hidden inode on Android GKI 5.15+ kernels even after v2.2.4 by adding kretprobes hooked at the arm64 syscall entry stubs (`__arm64_sys_newfstatat`, `__arm64_sys_statx`, `__arm64_sys_faccessat`, `__arm64_sys_faccessat2`, `__arm64_sys_readlinkat`). These stubs are stored as function pointers in `sys_call_table[]`, which forces the linker to keep them out-of-line at a fixed address regardless of LTO. The previous `inode_permission` / `vfs_getattr` / `__arm64_sys_getdents64` hooks are kept as belt-and-suspenders.
- Per-symbol probe registration is tolerant: kernels missing one of the syscalls (e.g. some 5.10 builds without `faccessat2`) just log a warning and continue. Look for `pathmask: hooked __arm64_sys_*` lines in `dmesg` to confirm which probes attached.
- Fix silent hook miss on Android GKI 5.15+ kernels caused by ThinLTO inlining `security_inode_permission` and `security_inode_getattr`. Switch to `inode_permission` and `vfs_getattr`. Handle the `inode_permission` argument register that shifts from `x0` to `x1` starting with 5.12 (where `user_namespace` / `mnt_idmap` was prepended) via a compile-time check.
- Add a one-shot `pr_info` line the first time each hook actually fires so users can confirm in `dmesg` that the hook is doing real work.

中文说明：

- 修复 v2.2.5 / v2.2.6 之后 `cat /system_ext/app/SoterService/SoterService.apk` 仍然能读到内容的问题。原因是 `inode_permission` 虽然是 `EXPORT_SYMBOL`，但 `link_path_walk` 里那个调用也被 ThinLTO 内联了 —— 所以 kretprobe 对某些进入路径有效（`fired (first time)` 日志会出现），但走正常 path walk 的 openat 完全绕过它。结果：被隐藏目录的元数据看不见，但**目录里面的子文件**却能直接 open 读取。
- 新增 hook `__arm64_sys_openat` 和 `__arm64_sys_openat2`。这两个跟 v2.2.5 那五个 syscall hook 同一原理：它们必须以函数指针放进 `sys_call_table[]`，链接器无法内联，所以 hook 必中。命中判断复用现有的 `regs[1]` 用户态文件名 + 前缀匹配。
- 解决 openat 加 hook 的 fd 泄漏老问题（这也是 v2.2.5 当初没敢挂它的原因）：exit 处理器现在会先调用 kprobe 解析出来的 `close_fd()` 释放 syscall 体里已经分配好的 fd，再把返回值改写成 `-ENOENT`。如果当前内核解析不到 `close_fd`，openat hook 会自动禁用（entry 不会标记 matched，让 open 正常返回），其他 syscall hook 仍然全部生效，**不会有 fd 泄漏**。
- 修复 WebUI 在 global 模式下健康检查误报"有路径当前不存在"：WebUI 跑的 `[ -e ]` 现在也被自身 hook 拦下来，刚好是模块工作的副作用。global+模块已加载时 WebUI 改读 `/sys/module/pathmask/parameters/resolved_count`（这个值在 insmod 阶段写入，hook 都还没生效，是内核真实视角），不再做用户态 stat 探测。诊断报告里的 "target existence" 段同样处理。`deny` 模式下 WebUI 是 root shell（uid=0）不在黑名单里，原有 `[ -e ]` 仍然准确，保持不变。
- 内核新增只读 sysfs 参数 `/sys/module/pathmask/parameters/resolved_count`，输出模块加载时成功解析的目标路径数量。
- v2.2.5：新增 `__arm64_sys_newfstatat` / `__arm64_sys_statx` / `__arm64_sys_faccessat` / `__arm64_sys_faccessat2` / `__arm64_sys_readlinkat` 五个 syscall 入口 hook，绕开 ThinLTO 把 VFS helper 内联进 `vfs_statx` 等调用者导致 `vfs_getattr` / `inode_permission` hook 不触发的问题。原有 `inode_permission` / `vfs_getattr` / `__arm64_sys_getdents64` hook 保留作为兜底。
- 每个 syscall 的 kretprobe 注册可容错：某些内核（比如部分 5.10 没有 `faccessat2`、或者更老的内核没有 `openat2`）某个符号注册失败时只打 warning 并继续注册剩下的 hook。
- v2.2.4：修复 GKI 5.15+ 上 `security_inode_permission` / `security_inode_getattr` 被 ThinLTO 内联导致 hook 看似已挂、实际从未触发的问题。改为 hook `inode_permission` 和 `vfs_getattr`，并按内核版本编译期切换 inode 参数寄存器（`x0` → `x1`）。
- 新增"首次触发日志"：每个 hook 第一次真正被调用时打印一行 `pr_info`，方便从 dmesg 确认 hook 真的在工作。

# PathMask 2.2.3

- Fix silent reboot on Android GKI kernels with `CONFIG_CFI_CLANG=y` (e.g. OnePlus 11 android13-5.15) caused by Clang CFI checking the indirect call to kprobe-resolved `kern_path` / `path_put`. The two indirect call sites are now wrapped in `__nocfi` helpers; the rest of the module retains full CFI coverage. Behaviour on OEM kernels that prune `EXPORT_SYMBOL(kern_path)` / `path_put` is unchanged.
- Fix install-time config seed: previously, even if you edited `target_path.conf` / `deny_packages.conf` etc. inside the zip before flashing, the boot script would unconditionally re-add the demo defaults (`/dev/cpuset/scene-daemon`, `com.chunqiunativecheck`, ...) into `/data/adb/pathmask/*.conf`. Now the zip's own `*.conf` files are the single source of truth on first install; subsequent boots leave persisted user config alone.
- Drop the unused `.defaults_v1_seeded` marker and inlined hardcoded defaults from `service.sh`. The WebUI "恢复默认" button still writes its own demo defaults explicitly.
- Unify `target_wait_seconds.conf` + `package_wait_seconds.conf` into a single `wait_seconds.conf`. Existing installs are auto-migrated by taking the larger of the two old values; the legacy files are then deleted. The packaging scripts and the `PATHMASK_*_WAIT_SECONDS` envvars collapse into `WaitSeconds` / `PATHMASK_WAIT_SECONDS`.
- Fix worst-case boot delay: the path wait and the package-resolution wait used to consume `wait_seconds` each, so the boot service could spend up to 2x the configured value before deciding to skip loading. Both phases now share a single deadline computed once, capping the total budget at exactly `wait_seconds`. Default lowered from 90 s to 60 s.
- Surface boot-load progress in the WebUI: `service.sh` now writes its phase to `/data/adb/pathmask/boot_state` (`init`, `waiting-targets`, `waiting-packages`, `loaded`, `skipped-*`, `failed-*`, `paused`, ...) and the WebUI health view shows live "还需等待最多 X 秒" status while the script is still waiting, so the default no longer looks like a hang.
- `uninstall.sh` now also removes `/data/adb/pathmask` so a clean reinstall starts from the zip-bundled defaults instead of inheriting stale UID caches, fail counters, or `boot_state`. `rmmod` keeps a best-effort try too.

中文说明：

- 修复在 `CONFIG_CFI_CLANG=y` 的 Android GKI 内核（例如一加 11 android13-5.15）上，因 Clang CFI 校验 kprobe 解析后的 `kern_path` / `path_put` 间接调用而导致的静默重启。两处间接调用改为 `__nocfi` 包装函数，模块其余部分仍保留完整的 CFI 覆盖；对裁剪了 `EXPORT_SYMBOL(kern_path)` / `path_put` 的 OEM 内核行为不变。
- 修复刷入配置被覆盖的问题：之前即便在刷机前手动改了 zip 内的 `target_path.conf` / `deny_packages.conf` 等，开机脚本仍会无条件把 `/dev/cpuset/scene-daemon`、`com.chunqiunativecheck` 等示例项追加进 `/data/adb/pathmask/*.conf`。现在以 zip 内的 `*.conf` 为唯一初始来源，之后开机不再回写默认。
- 移除 `service.sh` 中未使用的 `.defaults_v1_seeded` 标记和写死的默认项。WebUI 的"恢复默认"按钮仍能按需写入示例配置。
- 合并 `target_wait_seconds.conf` 和 `package_wait_seconds.conf` 为单一的 `wait_seconds.conf`。旧版本的两个文件会被自动迁移（取较大者），合并后旧文件会被删除。打包脚本与 `PATHMASK_*_WAIT_SECONDS` 环境变量也统一为 `WaitSeconds` / `PATHMASK_WAIT_SECONDS`。
- 修复总开机延迟问题：之前路径等待和包名解析等待各自独占 `wait_seconds` 秒，最坏情况下要花 2 倍时间才会决定跳过加载。现在两个阶段共用同一个截止时间，总等待预算就等于 `wait_seconds`。默认值从 90 秒降为 60 秒。
- WebUI 现在能显示开机加载进度：`service.sh` 会把当前阶段写入 `/data/adb/pathmask/boot_state`（`init`、`waiting-targets`、`waiting-packages`、`loaded`、`skipped-*`、`failed-*`、`paused` 等），WebUI 健康检查会实时显示"还需等待最多 X 秒"，避免默认等待被误认为没有生效。
- 卸载脚本现在会一并删除 `/data/adb/pathmask`，下次重装会从 zip 内的默认配置开始，而不是继承旧的 UID 缓存、失败计数、`boot_state` 等。`rmmod pathmask` 仍是 best-effort 尝试。

# PathMask 2.2.0

- Module author is now `Andrea-lyz`.
- WebUI adds config validation for paths, deny scope, direct UIDs, target existence, and package UID hints.
- WebUI adds a temporary pause button. It unloads `pathmask` without disabling the module; reboot or save-and-hot-reload restores hiding.
- Boot service now records consecutive module load failures and skips automatic loading after repeated `insmod` failures.
- Save-and-hot-reload clears the load-failure guard and retries immediately.
- Release packages keep KMI-specific update metadata to avoid cross-installing the wrong kernel package.

中文说明：

- 模块作者已改为 `Andrea-lyz`。
- WebUI 新增配置校验：检查隐藏路径、黑名单模式、直接 UID、路径是否存在、包名是否可能解析失败。
- WebUI 新增“暂停隐藏”：临时卸载 `pathmask`，不会禁用模块；重启或“保存并热重载”即可恢复。
- 开机脚本新增连续加载失败保护，多次 `insmod` 失败后会自动跳过后续自动加载。
- “保存并热重载”会清除失败保护并立即重试。
- Release 包继续使用按 KMI 区分的更新信息，避免刷错内核版本包。
