# Package the KernelSU module zip.
#
# By default this script preserves the conf files shipped in
# ksu-module/ verbatim -- treat that directory as the canonical
# source of truth for the bundled defaults. Each conf is only
# overwritten when its corresponding parameter is *explicitly*
# supplied at the command line. PowerShell makes "explicit vs
# default" introspectable via $PSBoundParameters, which is the
# only reliable way to do this without relying on stringly-typed
# sentinel values that could collide with legitimate input.
#
# Why this matters: in v2.2.8 the script's hardcoded TargetPath
# default silently clobbered the new
# `any:scene:/dev/???/scene_mode_category` line that lived in
# ksu-module/target_path.conf, so the released zip shipped users
# an out-of-date 3-line config even though the repo template was
# correct.
[CmdletBinding()]
param(
    [string]$KoPath = "kernel\pathmask.ko",
    [string]$Output = "out\pathmask-ksu.zip",
    [string]$TargetPath,
    [ValidateSet("0", "1")]
    [string]$HideDirents,
    [ValidateSet("0", "1")]
    [string]$EnableSyscallHooks,
    # Comma-separated subset of __arm64_sys_* fallback probes to
    # register: any combination of newfstatat,statx,faccessat,
    # faccessat2,readlinkat,openat,openat2 (or 'all' / 'none').
    # Empty string falls through to EnableSyscallHooks for
    # backward compat. Detection via $PSBoundParameters means
    # the caller can intentionally write an empty conf.
    [string]$SyscallHooks,
    [ValidateSet("global", "deny")]
    [string]$ScopeMode,
    [string]$DenyPackage,
    [string]$DenyUid,
    [int]$WaitSeconds,
    [string]$UpdateJson = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TemplateDir = Join-Path $RepoRoot "ksu-module"
$StageDir = Join-Path $RepoRoot "out\ksu-stage"

if (-not [System.IO.Path]::IsPathRooted($KoPath)) {
    $KoPath = Join-Path $RepoRoot $KoPath
}

if (-not [System.IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path $RepoRoot $Output
}

if (-not (Test-Path -LiteralPath $KoPath)) {
    throw "Missing kernel module: $KoPath"
}

if (-not (Test-Path -LiteralPath $TemplateDir)) {
    throw "Missing KernelSU template: $TemplateDir"
}

if (Test-Path -LiteralPath $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null

Copy-Item -Path (Join-Path $TemplateDir "*") -Destination $StageDir -Recurse -Force
Copy-Item -LiteralPath $KoPath -Destination (Join-Path $StageDir "pathmask.ko") -Force

$ModulePropPath = Join-Path $StageDir "module.prop"
if ($UpdateJson.Trim()) {
    $ModulePropLines = Get-Content -LiteralPath $ModulePropPath -Encoding UTF8 |
        Where-Object { $_ -notmatch "^updateJson=" }
    $ModulePropLines += "updateJson=$($UpdateJson.Trim())"
    Set-Content -LiteralPath $ModulePropPath -Value $ModulePropLines -Encoding UTF8
}

# Override only when caller explicitly passed the parameter. This
# preserves the conf files copied from $TemplateDir whenever the
# caller relies on the bundled defaults (the common case for CI).
if ($PSBoundParameters.ContainsKey('TargetPath')) {
    $TargetList = $TargetPath -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if (-not $TargetList) {
        throw "No target paths were provided"
    }
    Set-Content -LiteralPath (Join-Path $StageDir "target_path.conf") -Value $TargetList -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('HideDirents')) {
    Set-Content -LiteralPath (Join-Path $StageDir "hide_dirents.conf") -Value $HideDirents -NoNewline -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('EnableSyscallHooks')) {
    Set-Content -LiteralPath (Join-Path $StageDir "enable_syscall_hooks.conf") -Value $EnableSyscallHooks -NoNewline -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('SyscallHooks')) {
    Set-Content -LiteralPath (Join-Path $StageDir "syscall_hooks.conf") -Value $SyscallHooks -NoNewline -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('ScopeMode')) {
    Set-Content -LiteralPath (Join-Path $StageDir "scope_mode.conf") -Value $ScopeMode -NoNewline -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('DenyPackage')) {
    $DenyPackageList = $DenyPackage -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    Set-Content -LiteralPath (Join-Path $StageDir "deny_packages.conf") -Value $DenyPackageList -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('DenyUid')) {
    $DenyUidList = $DenyUid -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    Set-Content -LiteralPath (Join-Path $StageDir "deny_uids.conf") -Value $DenyUidList -Encoding ASCII
}
if ($PSBoundParameters.ContainsKey('WaitSeconds')) {
    Set-Content -LiteralPath (Join-Path $StageDir "wait_seconds.conf") -Value $WaitSeconds -NoNewline -Encoding ASCII
}

# Drop legacy wait conf files that an old template directory might
# have on disk. They are unused since v2.2.3 (merged into
# wait_seconds.conf) and would only confuse a fresh install.
foreach ($legacyName in @("target_wait_seconds.conf", "package_wait_seconds.conf")) {
    $legacyPath = Join-Path $StageDir $legacyName
    if (Test-Path -LiteralPath $legacyPath) {
        Remove-Item -LiteralPath $legacyPath -Force
    }
}

$TextExtensions = @(".conf", ".css", ".html", ".js", ".md", ".prop", ".sh")
Get-ChildItem -LiteralPath $StageDir -Recurse -File | ForEach-Object {
    if ($TextExtensions -contains $_.Extension) {
        $Content = [System.IO.File]::ReadAllText($_.FullName)
        $Content = $Content -replace "`r`n", "`n"
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($_.FullName, $Content, $Utf8NoBom)
    }
}

if (Test-Path -LiteralPath $Output) {
    Remove-Item -LiteralPath $Output -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$StageFullPath = (Resolve-Path -LiteralPath $StageDir).Path.TrimEnd("\", "/")
$Zip = [System.IO.Compression.ZipFile]::Open($Output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $StageDir -Recurse -File | ForEach-Object {
        $EntryName = $_.FullName.Substring($StageFullPath.Length).TrimStart("\", "/").Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $_.FullName, $EntryName) | Out-Null
    }
}
finally {
    $Zip.Dispose()
}

Write-Host "Created KernelSU package: $Output"
Write-Host "Stage dir: $StageDir (preserves ksu-module/ defaults unless overridden)"
foreach ($confName in @(
    "target_path.conf",
    "hide_dirents.conf",
    "enable_syscall_hooks.conf",
    "syscall_hooks.conf",
    "scope_mode.conf",
    "deny_packages.conf",
    "deny_uids.conf",
    "wait_seconds.conf"
)) {
    $confPath = Join-Path $StageDir $confName
    if (Test-Path -LiteralPath $confPath) {
        $size = (Get-Item -LiteralPath $confPath).Length
        Write-Host ("  {0,-30} ({1} bytes)" -f $confName, $size)
    }
}
if ($UpdateJson.Trim()) {
    Write-Host "Update JSON: $($UpdateJson.Trim())"
}
