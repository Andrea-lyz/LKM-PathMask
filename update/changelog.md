# PathMask 2.2.5

- Fix stat()/access()/readlink() still returning the hidden inode on Android GKI 5.15+ kernels even after v2.2.4. Even though `vfs_getattr` and `inode_permission` are `EXPORT_SYMBOL` and the kretprobes attached cleanly (the "fired (first time)" log lines did appear in `dmesg`), ThinLTO can still inline a copy of these helpers into in-kernel callers like `vfs_statx`. The exported symbol stays addressable for modules but no in-kernel call site actually goes through it, so `stat /system_ext/app/SoterService` kept leaking the inode while `ls` was correctly filtered. Symbol export is not the same as inline immunity on LTO kernels.
- Add a parallel set of kretprobes hooked at the arm64 syscall entry stubs (`__arm64_sys_newfstatat`, `__arm64_sys_statx`, `__arm64_sys_faccessat`, `__arm64_sys_faccessat2`, `__arm64_sys_readlinkat`). These stubs are stored as function pointers in `sys_call_table[]`, which forces the linker to keep them out-of-line at a fixed address regardless of LTO. The entry handler reads the user-supplied filename from `regs[1]`, prefix-matches it against the configured target paths, and the exit handler returns `-ENOENT` on a hit. The previous `inode_permission` / `vfs_getattr` / `__arm64_sys_getdents64` hooks are kept as belt-and-suspenders coverage for any path that does survive into VFS.
- `__arm64_sys_openat` is intentionally not hooked: a successful `openat` allocates an fd before kretprobe runs, so overriding the return value to `-ENOENT` would leak the fd. `openat` is left to the existing `inode_permission` hook, which fires during path walk before the file table is touched.
- Per-symbol probe registration is tolerant: kernels missing one of the syscalls (e.g. some 5.10 builds without `faccessat2`) just log a warning and continue with the rest of the syscalls hooked. Look for `pathmask: hooked __arm64_sys_*` lines in `dmesg` to confirm which probes attached, and `pathmask: syscall path hook fired (first time)` to confirm a real interception.
- Fix silent hook miss on Android GKI 5.15+ kernels: `security_inode_permission` and `security_inode_getattr` are tiny LSM dispatchers that ThinLTO inlines into their callers, leaving the exported symbols live in `kallsyms` but never actually called. The kretprobes attached cleanly but never fired, so paths stayed visible even with the module reported as `loaded` and all three hooks reported as `hooked`. Switch to `inode_permission` and `vfs_getattr`, which are large enough that LTO cannot inline them. The `inode_permission` argument register varies by kernel version (`x0` on <5.12, `x1` on 5.12+ where the `user_namespace` / `mnt_idmap` parameter is prepended), handled with a compile-time check.
- Add a one-shot `pr_info` line the first time each hook actually fires so users can confirm in `dmesg` that the hook is doing real work, not just registered. Look for `pathmask: inode_permission hook fired (first time)` and `pathmask: vfs_getattr hook fired (first time)`.

中文说明：

- 修复 v2.2.4 在 Android GKI 5.15+ 上 `stat /system_ext/app/SoterService` 等仍能返回 inode 的问题。即便 `vfs_getattr` / `inode_permission` 是 `EXPORT_SYMBOL`、kretprobe 也确实挂上了（dmesg 里 `fired (first time)` 日志的确出现过），ThinLTO 仍然可以把这些函数内联进 `vfs_statx` 之类的内核调用者。导出的符号对模块来说仍然是有效的入口地址，但内核里没有任何调用者会真正经过它，所以 `ls` 已经被过滤的同时 `stat` 还是会泄漏 inode。简单结论：在 LTO 内核上，符号被 export 不等于"不会被内联"。
- 新增一组 hook 在 arm64 系统调用入口 stub 上的 kretprobe：`__arm64_sys_newfstatat`、`__arm64_sys_statx`、`__arm64_sys_faccessat`、`__arm64_sys_faccessat2`、`__arm64_sys_readlinkat`。这些 stub 因为要被 `sys_call_table[]` 当作函数指针使用，链接器必须给它们留出固定地址的 out-of-line 拷贝，不会被 LTO 内联。entry 处理器从 `regs[1]` 读用户态传入的文件名，按前缀匹配目标路径，命中后在 exit 处理器里把返回值改写为 `-ENOENT`。原来的 `inode_permission` / `vfs_getattr` / `__arm64_sys_getdents64` 三个 hook 保留作为兜底。
- 不 hook `__arm64_sys_openat`：成功的 `openat` 在系统调用返回前已经分配了 fd，kretprobe 在 exit 阶段把返回值改成 `-ENOENT` 会留下一个不会被释放的 fd。`openat` 仍由现有的 `inode_permission` hook 在路径解析阶段拦截。
- 每个 syscall 的 kretprobe 注册是可容错的：某些内核（比如部分 5.10 没有 `faccessat2`）某个符号注册失败时只打 warning 并继续注册剩下的 hook。可以在 dmesg 里搜 `pathmask: hooked __arm64_sys_*` 看实际挂上了哪些，搜 `pathmask: syscall path hook fired (first time)` 来确认真的拦截到了。
- 修复 Android GKI 5.15+ 内核上 hook 看似已挂、实际从未触发的问题：`security_inode_permission` / `security_inode_getattr` 是很短的 LSM 分发器，被 ThinLTO 内联进了上层调用者；导出的符号在 `kallsyms` 里仍可见，但内核里没人真正调用它们。kretprobe 注册成功却永远不触发，于是模块明明显示"已加载，三个 hook 都 hooked"，路径却完全没隐藏。改为 hook `inode_permission` 和 `vfs_getattr` —— 这两个函数体足够大，LTO 不会内联。`inode_permission` 在 5.12 之后多了 `user_namespace` / `mnt_idmap` 参数，inode 从 `x0` 移到 `x1`，按内核版本编译期切换。
- 新增"首次触发日志"：每个 hook 第一次真正被调用时打印一行 `pr_info`。用户可以在 `dmesg` 里搜 `pathmask: inode_permission hook fired (first time)` 和 `pathmask: vfs_getattr hook fired (first time)` 来确认 hook 真的在工作，而不仅仅是注册成功了。

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
