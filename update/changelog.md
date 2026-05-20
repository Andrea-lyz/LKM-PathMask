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
