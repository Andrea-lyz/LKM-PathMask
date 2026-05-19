# PathMask

PathMask is a small Android arm64 / GKI external kernel module demo for
selectively masking configured filesystem paths. It is intended for controlled
testing on devices you own or administer.

[中文教程](README.zh-CN.md)

## What It Builds

- `kernel/pathmask.c`: kernel module source.
- `kernel/Kbuild`: external module target.
- `ksu-module/`: KernelSU module wrapper and WebUI.
- `tools/package_ksu.ps1` and `tools/package_ksu.sh`: packaging helpers.
- `.github/workflows/`: CI builds for Android KMI targets and release uploads.

Default hidden paths:

```text
/dev/cpuset/scene-daemon
/dev/scene
/system_ext/app/SoterService
```

Default deny-scope packages:

```text
com.chunqiunativecheck
com.eltavine.duckdetector
luna.safe.luna
```

## Current Status

Implemented:

- Hides direct access through `security_inode_permission`.
- Hides stat/getattr-style checks through `security_inode_getattr`.
- Filters `getdents64` results so target entries disappear from directory
  listings.
- Supports up to 16 target paths per module load.
- Supports `scope_mode=global` and `scope_mode=deny`.
- Resolves package names to UIDs in the KernelSU boot service.
- Stores runtime config under `/data/adb/pathmask`.
- Migrates old `/data/adb/nohello` config on first PathMask boot.
- Provides a KernelSU WebUI with config validation, health checks, paged logs,
  one-click diagnostic report copying, hot reload, and temporary pause.
- Skips future automatic load attempts after repeated `insmod` failures until
  the user retries from WebUI or clears the failure guard.
- Avoids importing `kern_path()` / `path_put()` directly. Target resolution
  resolves those helper addresses through kprobes so OEM kernels that prune
  unused VFS helper exports are less likely to reject the module.

Known limitations:

- At least one target path must exist before `insmod`; missing paths are
  skipped.
- Directory listing filtering compares `d_ino`; direct access checks still use
  both inode and device.
- Existing open file descriptors are not hidden retroactively.
- The module must match the device KMI/kernel version and arm64 ABI.
- Proc mount text files such as `/proc/*/mountinfo` and `/proc/*/mounts` are
  not filtered.
- Hot reload is convenient, but reboot loading is safer on unstable kernels.

## GitHub Actions And Releases

Pushing to `main`, pushing a `v*` tag, or running the workflow manually builds:

```text
android12-5.10_pathmask.ko
android12-5.10_pathmask-ksu.zip
...
android16-6.12_pathmask.ko
android16-6.12_pathmask-ksu.zip
```

Non-tag builds are uploaded to the `pathmask-latest` release. Tag builds are
uploaded to the matching version release.

Install the `*_pathmask-ksu.zip` file that matches your device KMI. The raw
`.ko` is also uploaded for manual testing.

Release zips include a KMI-specific `updateJson` entry. For example, the
`android15-6.6` package points KernelSU Manager to:

```text
https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android15-6.6.json
```

That JSON then points back to the matching `android15-6.6_pathmask-ksu.zip`
asset on the `pathmask-latest` release, so Manager updates do not cross-install
the wrong KMI package.

## Local Build

If your DDK container exports `KDIR`:

```sh
cd kernel
CONFIG_KSU=m CC=clang make
```

With an explicit kernel build directory:

```sh
cd kernel
make KDIR=/path/to/kernel/build
```

The output is:

```text
kernel/pathmask.ko
```

## Manual Test

```sh
adb shell
su
echo "demo secret" > /data/local/tmp/pathmask
insmod /data/local/tmp/pathmask.ko target_path=/data/local/tmp/pathmask
grep '^pathmask ' /proc/modules
ls -l /data/local/tmp/pathmask
```

Multiple paths:

```sh
insmod /data/local/tmp/pathmask.ko target_paths=/data/local/tmp/a,/data/local/tmp/b
```

Deny scope:

```sh
insmod /data/local/tmp/pathmask.ko target_paths=/data/local/tmp/a scope_mode=deny deny_uids=10123,10124
```

Disable directory-list filtering:

```sh
insmod /data/local/tmp/pathmask.ko target_paths=/data/local/tmp/a hide_dirents=0
```

Unload:

```sh
rmmod pathmask
```

## KernelSU Package

Windows PowerShell:

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-ksu.zip
```

Linux/macOS shell:

```sh
./tools/package_ksu.sh kernel/pathmask.ko out/pathmask-ksu.zip
```

Override target paths:

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-ksu.zip -TargetPath "/data/local/tmp/a,/data/local/tmp/b"
```

Direct-access-only package:

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-direct.zip -TargetPath "/data/local/tmp/pathmask" -HideDirents 0
```

Blacklist package:

```powershell
.\tools\package_ksu.ps1 -KoPath .\kernel\pathmask.ko -Output .\out\pathmask-ksu.zip -ScopeMode deny -DenyPackage "com.example.detector"
```

## Runtime Config Files

PathMask stores persistent runtime config in `/data/adb/pathmask`. The WebUI
edits these files for you, but they can also be inspected manually:

- `/data/adb/pathmask/target_path.conf`: hidden target paths, one absolute path
  per line. Blank lines and `#` comments are ignored. At least one configured
  path must exist before the module is loaded.
- `/data/adb/pathmask/scope_mode.conf`: hide scope. Use `deny` to hide only
  from configured app UIDs, or `global` to hide from every process.
- `/data/adb/pathmask/hide_dirents.conf`: directory-list filtering switch. `1`
  hides target entries from parent directory listings; `0` keeps direct access
  checks only.
- `/data/adb/pathmask/deny_packages.conf`: package blacklist, one package name
  per line. The boot service resolves these package names to UIDs before
  loading the kernel module.
- `/data/adb/pathmask/deny_uids.conf`: direct UID blacklist, one UID per line.
  Use this when package-name resolution is unreliable or when testing shell/app
  UIDs directly.
- `/data/adb/pathmask/target_wait_seconds.conf`: how long the boot service
  waits for configured target paths to appear before deciding whether to load.
- `/data/adb/pathmask/package_wait_seconds.conf`: how long the boot service
  waits for package names to resolve to UIDs in `deny` mode.

## WebUI Diagnosis

Open KernelSU Manager, enter PathMask WebUI, then use:

- `配置`: edit paths, mode, packages, and direct UIDs.
- `诊断`: view health checks and generate a report.
- `日志`: page through script, kernel, status, and config logs.
- `报告`: copy a single report for issue reports.

When a user says "module not loaded", ask them to open `诊断 -> 生成诊断 ->
复制诊断报告` and send the full text.

## Quick Device Checks

```sh
su
grep '^pathmask ' /proc/modules
cat /sys/module/pathmask/parameters/target_paths
cat /sys/module/pathmask/parameters/scope_mode
cat /sys/module/pathmask/parameters/deny_uids
logcat -d -s pathmask
dmesg | grep -Ei 'pathmask|unknown symbol|invalid module|module_layout'
```

Common failure classes:

- No `pathmask` in `/proc/modules`: boot service skipped or `insmod` failed.
- `Unknown symbol`: kernel export/KMI mismatch.
- `disagrees about version of symbol module_layout`: OEM kernel modversions
  CRC mismatch (see below).
- Empty `deny_uids` in deny mode: package names did not resolve to UIDs.
- All targets missing at boot: service skips loading.
- Old `nohello` module loaded: uninstall the old module and reboot.

## OEM Kernel Compatibility

Some OEM kernels (Xiaomi HyperOS / vivo OriginOS / etc.) enforce strict
modversions CRC validation. The released PathMask `.ko` is built against
Google GKI headers whose CRCs may not match the OEM kernel's internal
symbol table. When this happens, `dmesg` reports:

```text
pathmask: disagrees about version of symbol module_layout
insmod: failed to load pathmask.ko: Exec format error
```

**The module will not load, but it will NOT cause a reboot.** This is a
safe, clean rejection by the kernel.

Known affected devices:

- Xiaomi 13 Ultra (ishtar) — HyperOS 3.0.303 / 5.15.178-android13-8

Workarounds:

1. Ask the developer for a device-specific `.ko` built from the OEM's
   open-source kernel tree.
2. Build one yourself (see "Building from OEM Kernel Source" below).
3. If neither is available, uninstall the module — your device is not
   currently supported.

## Building from OEM Kernel Source

If the released `.ko` fails with `disagrees about version of symbol`,
you can build a device-specific ko from the OEM's open-source kernel:

```sh
# 1. Clone the OEM kernel source (example: Xiaomi 13 Ultra)
git clone --depth=1 -b ishtar-t-oss \
    https://github.com/MiCode/Xiaomi_Kernel_OpenSource.git kernel-source

# 2. Configure (disable LTO to avoid OOM on 16 GB machines)
cd kernel-source
make ARCH=arm64 LLVM=1 gki_defconfig
./scripts/config --file .config \
    -d LTO_CLANG -d LTO_CLANG_THIN -e LTO_NONE -d CFI_CLANG
make ARCH=arm64 LLVM=1 olddefconfig

# 3. Build until vmlinux.symvers appears (full vmlinux not needed)
make ARCH=arm64 LLVM=1 LLVM_IAS=1 -j4 vmlinux
# BTF/pahole errors can be ignored as long as vmlinux.symvers exists

# 4. Link Module.symvers
ln -sf vmlinux.symvers Module.symvers

# 5. Build pathmask.ko
cd /path/to/lkm-build-OP13/kernel
KDIR=/path/to/kernel-source make ARCH=arm64 CC=clang LLVM=1 LLVM_IAS=1

# 6. Verify
modinfo pathmask.ko | grep vermagic
llvm-readelf -SW pathmask.ko | grep __versions  # size must be non-zero
```

Package the resulting `pathmask.ko` with `tools/package_ksu.ps1` or
`tools/package_ksu.sh` to create a KernelSU-installable zip.

## Use Your Own Module

Replace `kernel/pathmask.c` and update `kernel/Kbuild`.

Single source file:

```makefile
obj-m += mymod.o
```

Multiple source files:

```makefile
obj-m += mymod.o
mymod-y := mymod_main.o mymod_hook.o mymod_util.o
```

Then update the KernelSU template and packaging scripts if your output module is
not named `pathmask.ko`.
