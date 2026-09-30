# Regression tests use text fixtures, never loadable kernel modules.
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$FixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pathmask-package-test-" + [guid]::NewGuid() + " with spaces")
$PackageScript = Join-Path $FixtureRoot "tools/package_ksu.ps1"
$Passed = 0

function Remove-FixturePath([string]$Path) {
    $Full = [System.IO.Path]::GetFullPath($Path)
    $Root = [System.IO.Path]::GetFullPath($FixtureRoot)
    $Prefix = $Root + [System.IO.Path]::DirectorySeparatorChar
    if ($Full -ne $Root -and -not $Full.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside fixture: $Full"
    }
    Remove-Item -LiteralPath $Full -Recurse -Force
}

function Write-Fixture([string]$Path, [string]$Marker) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Marker)
}

function Read-Entry($Archive, [string]$Name) {
    $Entry = $Archive.GetEntry($Name)
    if (-not $Entry) { throw "Missing ZIP entry: $Name" }
    $Reader = [System.IO.StreamReader]::new($Entry.Open())
    try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
}

function Test-Package([string]$Name, [hashtable]$Arguments, [string]$UpdateUrl, [string]$Marker) {
    $Arguments.Output = "out/$Name.zip"
    & $PackageScript @Arguments 6>$null
    $Archive = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $FixtureRoot $Arguments.Output))
    try {
        $Prop = Read-Entry $Archive "module.prop"
        $Updates = @($Prop -split "\r?\n" | Where-Object { $_ -like "updateJson=*" })
        if ($UpdateUrl) {
            if ($Updates.Count -ne 1 -or $Updates[0] -ne "updateJson=$UpdateUrl") {
                throw "$Name has the wrong update channel: $($Updates -join ', ')"
            }
        } elseif ($Updates.Count -ne 0) {
            throw "$Name should not have an inferred update channel"
        }
        if ((Read-Entry $Archive "pathmask.ko") -ne $Marker) { throw "$Name selected the wrong module" }
        if ($Arguments.ContainsKey("ProcguardKoPath") -and -not $Archive.GetEntry("procguard.ko")) {
            throw "$Name lost the explicit procguard companion"
        }
        foreach ($Conf in Get-ChildItem -LiteralPath (Join-Path $SourceRoot "ksu-module") -Filter "*.conf") {
            $Expected = [System.IO.File]::ReadAllText($Conf.FullName).Replace("`r`n", "`n")
            if ((Read-Entry $Archive $Conf.Name).Replace("`r`n", "`n") -ne $Expected) {
                throw "$Name changed default $($Conf.Name)"
            }
        }
    } finally { $Archive.Dispose() }
    $script:Passed++
    Write-Host "PASS $Name"
}

try {
    New-Item -ItemType Directory -Path (Join-Path $FixtureRoot "tools") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot "tools/package_ksu.ps1") -Destination $PackageScript
    Copy-Item -LiteralPath (Join-Path $SourceRoot "ksu-module") -Destination $FixtureRoot -Recurse
    $Kmis = @("android12-5.10", "android13-5.10", "android13-5.15", "android14-5.15",
              "android14-6.1", "android15-6.6", "android16-6.12", "android17-6.18")
    foreach ($Kmi in $Kmis) {
        $Ko = "kernel/out/$Kmi/pathmask.ko"
        $Guard = "kernel/out/$Kmi/procguard.ko"
        Write-Fixture (Join-Path $FixtureRoot $Ko) $Kmi
        Write-Fixture (Join-Path $FixtureRoot $Guard) "guard-$Kmi"
        Test-Package "explicit-$Kmi" @{ KoPath = $Ko; ProcguardKoPath = $Guard } "https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/$Kmi.json" $Kmi
    }
    $Latest = Join-Path $FixtureRoot "kernel/out/android15-6.6/pathmask.ko"
    [System.IO.File]::SetLastWriteTimeUtc($Latest, [DateTime]::UtcNow.AddMinutes(1))
    $Url = "https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android15-6.6.json"
    Test-Package "auto-newest" @{} $Url "android15-6.6"
    Test-Package "absolute-path" @{ KoPath = $Latest } $Url "android15-6.6"
    Test-Package "opt-out" @{ KoPath = $Latest; UpdateJson = "" } "" "android15-6.6"
    Test-Package "override" @{ KoPath = $Latest; UpdateJson = "https://example.invalid/update.json" } "https://example.invalid/update.json" "android15-6.6"
    Write-Fixture (Join-Path $FixtureRoot "out/android14-6.1_pathmask.ko") "prefixed"
    Test-Package "prefixed-name" @{ KoPath = "out/android14-6.1_pathmask.ko" } "https://raw.githubusercontent.com/Andrea-lyz/LKM-PathMask/main/update/android14-6.1.json" "prefixed"
    Write-Fixture (Join-Path $FixtureRoot "kernel/out/androidbad-6.6/pathmask.ko") "invalid-kmi"
    Test-Package "invalid-kmi" @{ KoPath = "kernel/out/androidbad-6.6/pathmask.ko" } "" "invalid-kmi"
    Remove-FixturePath (Join-Path $FixtureRoot "kernel/out")
    Write-Fixture (Join-Path $FixtureRoot "kernel/pathmask.ko") "legacy"
    Test-Package "legacy-fallback" @{} "" "legacy"
    Write-Host "$Passed packaging cases passed"
} finally {
    if (Test-Path -LiteralPath $FixtureRoot) { Remove-FixturePath $FixtureRoot }
}
