# PathMask 路径遮罩小白使用说明

PathMask 是一个 Android GKI/arm64 内核模块演示项目。它可以把指定路径在指定 App 面前伪装成“不存在”。请只在你自己的设备或你有明确授权的设备上测试。

## ⚠️ 重要提示

**PathMask 不是为了对抗游戏反作弊 / Root 检测而设计的**，它只是一个通用的 VFS 路径遮罩演示模块。把它套到游戏上属于不当使用，存在以下风险：

- 游戏反作弊可能把"系统能看见但目标 UID 看不见"的 kretprobe 行为识别为内核外挂信号。
- 一旦被判定为外挂，账号可能被临时或永久封禁；部分游戏会进一步封设备 / 硬件指纹。
- 本项目不会针对任何游戏反作弊做兼容测试，也不会跟进绕过检测的更新。

如果你坚持要用在这种场景，**封号、封机一切后果自负**。

## 我应该下载哪个文件

去 GitHub Release 下载和你设备 KMI 对应的模块包：

```text
android14-5.15_pathmask-ksu.zip
android14-6.1_pathmask-ksu.zip
android15-6.6_pathmask-ksu.zip
android16-6.12_pathmask-ksu.zip
```

如果你的设备是 Android 15 / 6.6，就下载：

```text
android15-6.6_pathmask-ksu.zip
```

不要直接把 `.ko` 当 KernelSU 模块刷入。KernelSU 需要刷入的是 `*-ksu.zip`。

## 怎么安装

1. 打开 KernelSU 管理器。
2. 进入模块页。
3. 选择本地安装。
4. 选择对应的 `*_pathmask-ksu.zip`。
5. 安装完成后重启手机。

## 怎么确认是否加载成功

打开终端或 adb shell：

```sh
su
grep '^pathmask ' /proc/modules
```

有类似输出就说明内核模块已经加载：

```text
pathmask 28672 0 - Live 0x0000000000000000 (O)
```

也可以看参数：

```sh
cat /sys/module/pathmask/parameters/target_paths
cat /sys/module/pathmask/parameters/scope_mode
cat /sys/module/pathmask/parameters/deny_uids
```

## WebUI 怎么用

KernelSU 管理器里进入 PathMask 的 WebUI。

页面分为四个页：

```text
配置：修改隐藏路径、黑名单 App、UID、模式
诊断：自动检查常见问题
日志：分页查看脚本日志、内核日志、配置和状态
报告：复制完整诊断报告
```

别人问你“为什么模块未加载”时，让他点：

```text
诊断 -> 生成诊断 -> 复制诊断报告
```

把完整报告发出来，比截图靠谱。

## 默认隐藏什么

默认隐藏路径：

```text
/dev/cpuset/scene-daemon
/dev/scene
/system_ext/app/SoterService
```

默认只对这几个包隐藏：

```text
com.chunqiunativecheck
com.eltavine.duckdetector
luna.safe.luna
```

这叫黑名单模式，也就是只有被勾选或写入的 App 看不到这些路径，其它 App 仍然能正常访问。

## 保存和热重载有什么区别

`保存配置`：只写配置文件，重启后由开机脚本加载新配置。

`保存并热重载`：保存后立刻执行 `rmmod pathmask` 和 `insmod pathmask.ko`，不需要重启。

`暂停隐藏`：临时卸载 `pathmask`，隐藏立即停止；不会禁用模块，重启或再次点击“保存并热重载”会恢复。

`校验配置`：检查路径格式、黑名单是否为空、UID 是否为数字、目标路径当前是否存在、包名是否可能解析不到 UID。

热重载很方便，但如果某些内核或 KernelSU 环境不稳定，可能会黑屏重启。遇到这种情况就只保存配置，然后手动重启手机。

如果模块连续多次 `insmod` 失败，开机脚本会自动跳过后续加载，避免反复失败影响启动。修好配置后，在 WebUI 点击“保存并热重载”会重置这个保护并重新尝试加载。

## 常见问题

### 1. UI 显示模块未加载

先看：

```sh
su
grep '^pathmask ' /proc/modules
logcat -d -s pathmask
dmesg | grep -Ei 'pathmask|unknown symbol|invalid module|module_layout'
```

如果 `/proc/modules` 里没有 `pathmask`，说明模块确实没加载。

### 2. dmesg 没有 pathmask 日志

`dmesg` 是内核环形日志，旧日志可能被覆盖。判断模块是否加载，优先看：

```sh
grep '^pathmask ' /proc/modules
```

### 3. Unknown symbol / Invalid module format

通常是 `.ko` 和设备内核 KMI 不匹配，或者厂商内核裁剪了符号。请先换对应 KMI 的 Release 包。

如果日志里出现 `Unknown symbol filp_open`，说明你使用的是旧版 PathMask 包，请更新到新版 Release。

### 4. 黑名单模式不生效

检查 UID 是否解析到了：

```sh
cat /sys/module/pathmask/parameters/deny_uids
```

如果为空，说明包名没有解析到 UID。确认 App 已安装、包名写对，或者在 WebUI 里直接填写 UID。

### 5. 路径没隐藏

检查目标路径是否在模块加载前存在：

```sh
cat /sys/module/pathmask/parameters/target_paths
ls -ld /你要隐藏的路径
```

路径不存在时加载模块，会被跳过。

## 一键排查命令

```sh
su
grep '^pathmask ' /proc/modules
ls -l /data/adb/modules/pathmask/pathmask.ko
cat /data/adb/pathmask/target_path.conf 2>/dev/null
cat /data/adb/pathmask/scope_mode.conf 2>/dev/null
cat /data/adb/pathmask/deny_packages.conf 2>/dev/null
cat /data/adb/pathmask/deny_uids.conf 2>/dev/null
cat /sys/module/pathmask/parameters/target_paths 2>/dev/null
cat /sys/module/pathmask/parameters/scope_mode 2>/dev/null
cat /sys/module/pathmask/parameters/deny_uids 2>/dev/null
logcat -d -s pathmask
dmesg | grep -Ei 'pathmask|unknown symbol|invalid module|module_layout'
```

## KSU 管理器更新按钮怎么部署

KernelSU 的 `module.prop` 支持 `updateJson=<url>`。PathMask 不能只放一个统一更新链接，因为不同 KMI 需要不同的 `.ko`，刷错包会加载失败。

现在的部署方式是按 KMI 拆分更新清单：

```text
update/android12-5.10.json
update/android13-5.10.json
update/android13-5.15.json
update/android14-5.15.json
update/android14-6.1.json
update/android15-6.6.json
update/android16-6.12.json
```

GitHub Actions 打包时会自动给对应 zip 注入对应的 `updateJson`。例如：

```text
android15-6.6_pathmask-ksu.zip
updateJson=https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android15-6.6.json
```

这个 JSON 里的 `zipUrl` 再指向：

```text
https://github.com/Andrea-lyz/LKM-PathMask/releases/download/pathmask-latest/android15-6.6_pathmask-ksu.zip
```

以后发新版时需要做三件事：

1. 提高 `ksu-module/module.prop` 里的 `version` 和 `versionCode`。
2. 同步修改 `update/*.json` 里的 `version`、`versionCode` 和更新说明链接。
3. 推送到 `main`，等待 Actions 重新生成 Release 资产。

KSU 管理器判断是否有更新主要看 `versionCode`，所以每次发新版都要递增。

## 配置文件分别是干什么的

PathMask 的持久化配置都放在 `/data/adb/pathmask`。一般建议用 WebUI 改，手动查看或排查时可以看下面这些文件。

`/data/adb/pathmask/target_path.conf`

要隐藏的路径列表，一行一个绝对路径。空行和 `#` 开头的注释会被忽略。模块加载前至少要有一个路径真实存在，否则开机脚本会跳过加载。

`/data/adb/pathmask/scope_mode.conf`

隐藏范围。填 `deny` 表示黑名单模式，只对指定 App/UID 隐藏；填 `global` 表示全局隐藏，所有进程都看不到目标路径。

`/data/adb/pathmask/hide_dirents.conf`

是否隐藏上级目录里的列表项。填 `1` 时，`ls /system_ext/app` 这类目录列表里也会过滤目标；填 `0` 时，只处理直接访问、stat/getattr 等检查。

`/data/adb/pathmask/deny_packages.conf`

黑名单包名列表，一行一个包名。开机脚本会把这些包名解析成 UID，再传给内核模块。包名写错或 App 没安装时，可能解析不到 UID。

`/data/adb/pathmask/deny_uids.conf`

直接填写 UID，一行一个数字。适合包名解析失败、测试 shell UID，或者你已经知道目标 App UID 的情况。

`/data/adb/pathmask/wait_seconds.conf`

开机时等待隐藏路径出现、以及 deny 模式下等待包名解析为 UID 的总秒数预算。默认 60。两个等待阶段共用同一个截止时间，所以最坏情况下只会延迟这么多，而不是这一项的两倍。路径或包名出现得慢的设备可以调大；也可以在 WebUI 的「开机等待秒数」里直接改。

`/data/adb/pathmask/boot_state`

开机脚本运行到哪一阶段的状态文件，由 service.sh 自动写入：`init`、`waiting-targets`、`waiting-packages`、`loaded`、`already-loaded`、`paused`、`skipped-*`、`failed-*` 等。WebUI 健康检查会读它显示「正在等待，剩 X 秒」之类的进度，避免误以为没生效。手动改没意义，是观测用的。

## 自己打包

Windows PowerShell：

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-ksu.zip
```

指定隐藏路径：

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-ksu.zip -TargetPath "/dev/scene,/system_ext/app/SoterService"
```

## 自己从源码编译

如果发布的 ko 跟你的设备内核不兼容（例如 `disagrees about version of symbol module_layout`），可以用厂商开源的内核源码自己编一份精确兼容的 ko。

前提：

- Linux 环境（WSL2 / Ubuntu / Debian 均可）
- 厂商开源内核源码（如 MiCode/Xiaomi_Kernel_OpenSource 对应分支）
- Google AOSP prebuilt clang（跟你设备内核 banner 里的 clang 版本一致）

步骤概要：

```sh
# 1. 克隆厂商内核源码
git clone --depth=1 -b <你设备的分支> <厂商内核仓库> kernel-source

# 2. 配置 + 禁 LTO（避免内存爆炸）
cd kernel-source
make ARCH=arm64 LLVM=1 gki_defconfig
./scripts/config --file .config -d LTO_CLANG -d LTO_CLANG_THIN -e LTO_NONE -d CFI_CLANG
make ARCH=arm64 LLVM=1 olddefconfig

# 3. 编到 vmlinux.symvers 出来即可（不需要完整 vmlinux）
make ARCH=arm64 LLVM=1 LLVM_IAS=1 -j4 vmlinux
# 如果 BTF/pahole 报错可以忽略，只要 vmlinux.symvers 产出就行

# 4. 软链 Module.symvers
ln -sf vmlinux.symvers Module.symvers

# 5. 编 pathmask.ko
cd /path/to/lkm-build-OP13/kernel
KDIR=/path/to/kernel-source make ARCH=arm64 CC=clang LLVM=1 LLVM_IAS=1

# 6. 验证
modinfo pathmask.ko | grep vermagic
llvm-readelf -SW pathmask.ko | grep __versions  # 大小应非零
```

编出来的 ko 用 `tools/package_ksu.ps1` 打包成 KSU zip 即可安装。
