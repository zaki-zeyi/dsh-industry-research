Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = $PSScriptRoot
$script:LogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-industry-research-bundle.log'
$script:Messages = $null
$script:TestRoot = $env:DSH_BUNDLE_TEST_ROOT
$script:TestMode = -not [string]::IsNullOrWhiteSpace($script:TestRoot)
$script:NoLaunch = $script:TestMode -or ($env:DSH_BUNDLE_NO_LAUNCH -eq '1')
$script:LocalAppData = $env:LOCALAPPDATA

function Read-Messages {
  $path = Join-Path $script:Root 'messages.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Installer messages.json is missing: $path"
  }
  $json = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  return ($json | ConvertFrom-Json)
}

function T {
  param([string]$Key)
  if ($null -eq $script:Messages) { return $Key }
  $property = $script:Messages.PSObject.Properties[$Key]
  if ($null -eq $property) { return $Key }
  return [string]$property.Value
}

function Write-Log {
  param([string]$Text)
  try {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
  } catch {
    # Logging must never block installation.
  }
}

function Write-Step {
  param([string]$Key)
  $text = T $Key
  Write-Host ''
  Write-Host $text -ForegroundColor Cyan
  Write-Log $text
}

function Show-Message {
  param([string]$Text, [string]$Icon = 'Information')
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($Text, (T 'title'), 'OK', $Icon) | Out-Null
  } catch {
    # A message box is best effort on systems without interactive desktop access.
  }
}

function Ask-YesNo {
  param([string]$Text)
  Add-Type -AssemblyName System.Windows.Forms
  $answer = [System.Windows.Forms.MessageBox]::Show($Text, (T 'title'), 'YesNo', 'Question')
  return $answer -eq [System.Windows.Forms.DialogResult]::Yes
}

function Fail {
  param([string]$Key, [string]$Detail = '')
  $text = T $Key
  if (-not [string]::IsNullOrWhiteSpace($Detail)) {
    $text = $text + "`r`n`r`n" + $Detail
  }
  $text = $text + "`r`n`r`n" + (T 'logHint') + ' ' + $script:LogPath
  Write-Host $text -ForegroundColor Red
  Write-Log $text
  if (-not $script:TestMode) { Show-Message $text 'Error' }
  exit 1
}

function Get-ObjectProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Set-ObjectProperty {
  param($Object, [string]$Name, $Value)
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $Object.$Name = $Value
  }
}

function Write-JsonFile {
  param([string]$Path, $Object)
  $json = $Object | ConvertTo-Json -Depth 20
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json + "`n", $encoding)
}

function Get-DshExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'))
  }
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $candidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'))
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
    $candidates.Add((Join-Path $programFilesX86 'DeepSeek Harness\DeepSeek Harness.exe'))
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    $items = @()
    try { $items = @(Get-ItemProperty -Path $key -ErrorAction Stop) } catch { continue }
    foreach ($item in $items) {
      $displayName = [string](Get-ObjectProperty $item 'DisplayName')
      if ($displayName -notlike '*DeepSeek Harness*') { continue }
      $displayIcon = [string](Get-ObjectProperty $item 'DisplayIcon')
      if (-not [string]::IsNullOrWhiteSpace($displayIcon)) {
        $displayIcon = $displayIcon.Trim('"') -replace ',\d+$', ''
        if (Test-Path -LiteralPath $displayIcon -PathType Leaf) { return $displayIcon }
      }
      $location = [string](Get-ObjectProperty $item 'InstallLocation')
      if (-not [string]::IsNullOrWhiteSpace($location)) {
        $candidate = Join-Path $location 'DeepSeek Harness.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      }
    }
  }
  return $null
}

function Install-DeepSeekHarness {
  $setup = Join-Path $script:Root 'DeepSeek-Harness-Setup.exe'
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "Bundled DeepSeek Harness installer is missing: $setup"
  }
  Write-Step 'installingDsh'
  Write-Log 'Running DeepSeek Harness installer silently.'
  try {
    Start-Process -FilePath $setup -ArgumentList @('/S', '/currentuser') -Wait -WindowStyle Hidden | Out-Null
  } catch {
    Write-Log ('Silent installer failed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 3
  $found = Get-DshExecutable
  if (-not [string]::IsNullOrWhiteSpace($found)) { return $found }

  Write-Step 'installerFallback'
  Write-Log 'Running DeepSeek Harness installer with the graphical wizard.'
  Start-Process -FilePath $setup -ArgumentList @('/currentuser') -Wait | Out-Null
  Start-Sleep -Seconds 3
  return Get-DshExecutable
}

function Ensure-DshStopped {
  $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
  if ($processes.Count -eq 0) { return }
  if (-not (Ask-YesNo (T 'dshRunning'))) { Fail 'closeCancelled' }
  foreach ($process in $processes) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { Write-Log ('Could not stop process ' + $process.Id + ': ' + $_.Exception.Message) }
  }
  Start-Sleep -Seconds 3
  $remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
  if ($remaining.Count -gt 0) { Fail 'closeCancelled' }
}

function Install-PluginFiles {
  $pluginRoot = Join-Path $script:Root 'plugin'
  $packages = @(Get-ChildItem -LiteralPath $pluginRoot -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf })
  if ($packages.Count -ne 1) { Fail 'pluginMissing' }
  $source = $packages[0].FullName
  $manifestPath = Join-Path $source 'package.json'
  $manifest = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  $version = [string](Get-ObjectProperty $manifest 'version')
  if ([string]::IsNullOrWhiteSpace($version)) { Fail 'pluginMissing' }

  $installRoot = Join-Path $script:LocalAppData 'DSH Industry Research'
  $target = Join-Path $installRoot ('plugin\' + $version)
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  foreach ($name in @('Uninstall.cmd', 'Uninstall.ps1', 'messages.json', 'README.txt', 'THIRD-PARTY-NOTICES.txt', 'manifest.json')) {
    $sourceFile = Join-Path $script:Root $name
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
      Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $installRoot $name) -Force
    }
  }
  return [pscustomobject]@{
    Version = $version
    InstallRoot = $installRoot
    Target = $target
    PosixTarget = ($target -replace '\\', '/')
  }
}

function Read-ProfileManifest {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  $manifest = $text | ConvertFrom-Json
  if ($null -eq $manifest -or $manifest -isnot [pscustomobject]) {
    throw (T 'profileInvalid') + "`r`n" + $Path
  }
  return $manifest
}

function Update-DesktopProfile {
  param([string]$DshHome, $Plugin)
  $profileDir = Join-Path $DshHome 'profiles\desktop'
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  $manifestPath = Join-Path $profileDir 'package.json'
  $exists = Test-Path -LiteralPath $manifestPath -PathType Leaf
  if ($exists) {
    $backup = $manifestPath + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
    try {
      $manifest = Read-ProfileManifest $manifestPath
    } catch {
      Fail 'profileInvalid' ($manifestPath + "`r`n" + $_.Exception.Message)
    }
  } else {
    $manifest = [pscustomobject]@{
      name = 'dsh-profile-desktop'
      private = $true
      dependencies = [pscustomobject]@{}
      dsh = [pscustomobject]@{
        profile = [pscustomobject]@{
          bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
        }
      }
    }
  }

  $dependencies = Get-ObjectProperty $manifest 'dependencies'
  if ($null -eq $dependencies) {
    $dependencies = [pscustomobject]@{}
    Set-ObjectProperty $manifest 'dependencies' $dependencies
  }
  Set-ObjectProperty $dependencies 'dsh-industry-research' ('link:' + $Plugin.PosixTarget)

  $dsh = Get-ObjectProperty $manifest 'dsh'
  if ($null -eq $dsh) {
    $dsh = [pscustomobject]@{}
    Set-ObjectProperty $manifest 'dsh' $dsh
  }
  $profile = Get-ObjectProperty $dsh 'profile'
  if ($null -eq $profile) {
    $profile = [pscustomobject]@{}
    Set-ObjectProperty $dsh 'profile' $profile
  }
  $bundlesValue = Get-ObjectProperty $profile 'bundles'
  $bundles = @()
  if ($null -ne $bundlesValue) {
    $bundles = @($bundlesValue | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  if ($bundles -notcontains 'dsh-industry-research') {
    $bundles += 'dsh-industry-research'
  }
  Set-ObjectProperty $profile 'bundles' $bundles
  Write-JsonFile $manifestPath $manifest

  $patchPath = Join-Path $profileDir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    [System.IO.File]::WriteAllText($patchPath, "[]`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  $workspacePath = Join-Path $profileDir 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $workspacePath -PathType Leaf)) {
    $workspace = "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n"
    [System.IO.File]::WriteAllText($workspacePath, $workspace, (New-Object System.Text.UTF8Encoding($false)))
  }

  $nodeModules = Join-Path $profileDir 'node_modules'
  New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
  $linkPath = Join-Path $nodeModules 'dsh-industry-research'
  if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $linkType = [string](Get-ObjectProperty $item 'LinkType')
    if ($linkType -eq 'Junction' -or $linkType -eq 'SymbolicLink') {
      [System.IO.Directory]::Delete($linkPath, $false)
    } elseif ($item.PSIsContainer) {
      throw "Existing dsh-industry-research directory is not a link: $linkPath"
    } else {
      Remove-Item -LiteralPath $linkPath -Force
    }
  }
  New-Item -ItemType Junction -Path $linkPath -Target $Plugin.Target | Out-Null
  return $profileDir
}

try {
  $script:Messages = Read-Messages
  Write-Log 'Installer started.'
  if ($script:TestMode) {
    if ([string]::IsNullOrWhiteSpace($script:LocalAppData)) { throw 'LOCALAPPDATA is not set.' }
    $script:LocalAppData = Join-Path $script:TestRoot 'LocalAppData'
    New-Item -ItemType Directory -Path $script:LocalAppData -Force | Out-Null
  }
  if (-not $script:TestMode -and $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail 'unsupportedArch' }

  $userHome = [Environment]::GetFolderPath('UserProfile')
  $dshHome = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = Join-Path $userHome '.dsh' }
  if ($script:TestMode) { $dshHome = Join-Path $script:TestRoot '.dsh' }

  Write-Step 'checkingDsh'
  $dshPath = $env:DSH_BUNDLE_TEST_DSH
  if (-not $script:TestMode) {
    $dshPath = Get-DshExecutable
    if ([string]::IsNullOrWhiteSpace($dshPath)) { $dshPath = Install-DeepSeekHarness }
    if ([string]::IsNullOrWhiteSpace($dshPath)) { Fail 'dshNotFound' }
    Ensure-DshStopped
  }

  Write-Step 'installingPlugin'
  $plugin = Install-PluginFiles
  $profileDir = Update-DesktopProfile -DshHome $dshHome -Plugin $plugin
  Write-Log ('Plugin installed at ' + $plugin.Target)
  Write-Log ('Desktop profile updated at ' + $profileDir)

  if ($script:TestMode) {
    $result = [pscustomobject]@{
      status = 'installed'
      pluginVersion = $plugin.Version
      pluginPath = $plugin.Target
      profilePath = $profileDir
      dshHome = $dshHome
      dshPath = $dshPath
      testMode = $true
    }
    Write-JsonFile (Join-Path $script:TestRoot 'install-result.json') $result
    Write-Host (T 'installSuccessNoLaunch') -ForegroundColor Green
    exit 0
  }

  if (-not $script:NoLaunch) {
    Start-Process -FilePath $dshPath -WorkingDirectory (Split-Path -Parent $dshPath) | Out-Null
  }
  if ($script:NoLaunch) { Show-Message (T 'installSuccessNoLaunch') 'Information' }
  else { Show-Message (T 'installSuccess') 'Information' }
  exit 0
} catch {
  Fail 'installFailed' $_.Exception.Message
}
