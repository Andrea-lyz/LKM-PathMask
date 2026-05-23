param(
    [string]$KoPath = "kernel\pathmask.ko",
    [string]$Output = "out\pathmask-ksu.zip",
    [string]$TargetPath = "/dev/cpuset/scene-daemon,/dev/scene,/system_ext/app/SoterService",
    [ValidateSet("0", "1")]
    [string]$HideDirents = "1",
    [ValidateSet("0", "1")]
    [string]$EnableSyscallHooks = "0",
    [ValidateSet("global", "deny")]
    [string]$ScopeMode = "deny",
    [string]$DenyPackage = "com.chunqiunativecheck,com.eltavine.duckdetector,luna.safe.luna",
    [string]$DenyUid = "",
    [int]$WaitSeconds = 60,
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

$TargetList = $TargetPath -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if (-not $TargetList) {
    throw "No target paths were provided"
}

$DenyPackageList = $DenyPackage -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$DenyUidList = $DenyUid -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }

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

Set-Content -LiteralPath (Join-Path $StageDir "target_path.conf") -Value $TargetList -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "hide_dirents.conf") -Value $HideDirents -NoNewline -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "enable_syscall_hooks.conf") -Value $EnableSyscallHooks -NoNewline -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "scope_mode.conf") -Value $ScopeMode -NoNewline -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "deny_packages.conf") -Value $DenyPackageList -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "deny_uids.conf") -Value $DenyUidList -Encoding ASCII
Set-Content -LiteralPath (Join-Path $StageDir "wait_seconds.conf") -Value $WaitSeconds -NoNewline -Encoding ASCII
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
Write-Host "Target paths: $($TargetList -join ', ')"
Write-Host "Hide dirents: $HideDirents"
Write-Host "Enable syscall hooks: $EnableSyscallHooks"
Write-Host "Scope mode: $ScopeMode"
Write-Host "Deny packages: $($DenyPackageList -join ', ')"
Write-Host "Deny UIDs: $($DenyUidList -join ', ')"
Write-Host "Wait seconds: $WaitSeconds"
if ($UpdateJson.Trim()) {
    Write-Host "Update JSON: $($UpdateJson.Trim())"
}
