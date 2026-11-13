param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [string]$ResultPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
$installerPath = [System.IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Installer not found: $installerPath" }

$registryKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7D83B2E5-2D8F-4B2A-9D8A-3A4E1C7B6F10}-Test'
$registryPath = 'HKCU:\' + $registryKey
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-installer-acceptance-' + [guid]::NewGuid().ToString('N'))
$tempCopy = Join-Path $testRoot 'DSH-Industry-Research-Setup.exe'
$oldTestRoot = $env:DSH_BUNDLE_TEST_ROOT
$oldLocalAppData = $env:LOCALAPPDATA
$processes = New-Object System.Collections.Generic.List[object]
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail = '')
  $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail }) | Out-Null
  if (-not $Passed) { throw "Acceptance check failed: $Name $Detail" }
}

function Wait-ForExit {
  param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$Name)
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch { }
    throw "$Name timed out after $TimeoutSeconds seconds."
  }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  Copy-Item -LiteralPath $installerPath -Destination $tempCopy -Force
  $env:DSH_BUNDLE_TEST_ROOT = $testRoot

  if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Recurse -Force }

  $first = Start-Process -FilePath $tempCopy -PassThru
  $processes.Add($first) | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $first.Refresh()
    if ($first.HasExited) { break }
    if ($first.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  $first.Refresh()
  Add-Check 'first installer window visible' (-not $first.HasExited -and $first.MainWindowHandle -ne [IntPtr]::Zero) ('PID=' + $first.Id)

  $second = Start-Process -FilePath $tempCopy -PassThru
  $processes.Add($second) | Out-Null
  Wait-ForExit -Process $second -TimeoutSeconds 20 -Name 'second installer instance'
  Add-Check 'second installer exits without opening a window' ($second.ExitCode -ne 0) ('exit=' + $second.ExitCode)

  try { $first.CloseMainWindow() | Out-Null } catch { }
  if (-not $first.WaitForExit(10000)) { Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500

  $install = Start-Process -FilePath $tempCopy -ArgumentList '/S' -WindowStyle Hidden -PassThru
  $processes.Add($install) | Out-Null
  Wait-ForExit -Process $install -TimeoutSeconds 600 -Name 'silent install'
  Add-Check 'silent install exit code' ($install.ExitCode -eq 0) ('exit=' + $install.ExitCode)

  $installRoot = Join-Path (Join-Path $testRoot 'LocalAppData') 'DSH Industry Research'
  $pluginRoot = Join-Path (Join-Path $installRoot 'plugin') $version
  $uninstaller = Join-Path $installRoot 'Uninstall.exe'
  Add-Check 'plugin files installed' (Test-Path -LiteralPath (Join-Path $pluginRoot 'package.json') -PathType Leaf) $pluginRoot
  Add-Check 'standard uninstaller generated' (Test-Path -LiteralPath $uninstaller -PathType Leaf) $uninstaller

  if (-not (Test-Path -LiteralPath $registryPath)) { throw 'Uninstall registry entry is missing.' }
  $entry = Get-ItemProperty -LiteralPath $registryPath
  Add-Check 'uninstall registry display name' (([string]$entry.DisplayName) -like 'DSH*') ([string]$entry.DisplayName)
  Add-Check 'uninstall registry version' ([string]$entry.DisplayVersion -eq $version) ([string]$entry.DisplayVersion)
  Add-Check 'uninstall registry location' ([string]$entry.InstallLocation -eq $installRoot) ([string]$entry.InstallLocation)
  Add-Check 'uninstall command points to generated uninstaller' (([string]$entry.UninstallString) -like ('*' + $uninstaller + '*')) ([string]$entry.UninstallString)
  Add-Check 'quiet uninstall command is silent' (([string]$entry.QuietUninstallString) -like '*/S*') ([string]$entry.QuietUninstallString)
  Add-Check 'uninstall registry no modify' ([int]$entry.NoModify -eq 1) ([string]$entry.NoModify)
  Add-Check 'uninstall registry no repair' ([int]$entry.NoRepair -eq 1) ([string]$entry.NoRepair)

  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
  $processes.Add($uninstall) | Out-Null
  Wait-ForExit -Process $uninstall -TimeoutSeconds 120 -Name 'silent uninstall'
  Add-Check 'silent uninstall exit code' ($uninstall.ExitCode -eq 0) ('exit=' + $uninstall.ExitCode)
  $cleanupDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $cleanupDeadline) {
    if (-not (Test-Path -LiteralPath $registryPath) -and -not (Test-Path -LiteralPath $pluginRoot)) { break }
    Start-Sleep -Milliseconds 250
  }
  Add-Check 'uninstall registry entry removed' (-not (Test-Path -LiteralPath $registryPath)) $registryPath
  Add-Check 'managed plugin directory removed' (-not (Test-Path -LiteralPath $pluginRoot)) $pluginRoot

  $result = [pscustomobject]@{
    status = 'passed'
    version = $version
    installer = $installerPath
    testRoot = $testRoot
    checks = $checks.ToArray()
  }
  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    $resultFile = [System.IO.Path]::GetFullPath($ResultPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $resultFile) -Force | Out-Null
    [System.IO.File]::WriteAllText($resultFile, ($result | ConvertTo-Json -Depth 6) + "`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  $result | ConvertTo-Json -Depth 6
} finally {
  foreach ($process in $processes) {
    try { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } } catch { }
  }
  if (Test-Path -LiteralPath $registryPath) {
    try { Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
  if ($null -eq $oldTestRoot) { Remove-Item Env:DSH_BUNDLE_TEST_ROOT -ErrorAction SilentlyContinue } else { $env:DSH_BUNDLE_TEST_ROOT = $oldTestRoot }
  if ($null -eq $oldLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $oldLocalAppData }
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $resolvedTest = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\')
  if ($resolvedTest.StartsWith($resolvedTemp + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    try { Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}
