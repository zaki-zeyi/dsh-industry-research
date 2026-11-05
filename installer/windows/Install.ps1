Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = $PSScriptRoot
$script:LogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-industry-research-bundle.log'
$script:Messages = $null
$script:TestRoot = $env:DSH_BUNDLE_TEST_ROOT
$script:TestMode = -not [string]::IsNullOrWhiteSpace($script:TestRoot)
$script:NoLaunch = $script:TestMode -or ($env:DSH_BUNDLE_NO_LAUNCH -eq '1')
$script:LocalAppData = $env:LOCALAPPDATA
. (Join-Path $PSScriptRoot 'Compatibility.ps1')

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

function Get-ExtendedPath {
  param([string]$Path)
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if ($fullPath.StartsWith('\\?\')) { return $fullPath }
  if ($fullPath.StartsWith('\\')) { return '\\?\UNC\' + $fullPath.Substring(2) }
  return '\\?\' + $fullPath
}

function Copy-DirectoryTree {
  param([string]$Source, [string]$Destination)
  $sourceRoot = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
  $destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
  [System.IO.Directory]::CreateDirectory((Get-ExtendedPath $destinationRoot)) | Out-Null
  foreach ($directory in @(Get-ChildItem -LiteralPath $sourceRoot -Directory -Recurse -Force)) {
    $relative = $directory.FullName.Substring($sourceRoot.Length).TrimStart('\')
    [System.IO.Directory]::CreateDirectory((Get-ExtendedPath (Join-Path $destinationRoot $relative))) | Out-Null
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force)) {
    $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $target = Join-Path $destinationRoot $relative
    [System.IO.Directory]::CreateDirectory((Get-ExtendedPath (Split-Path -Parent $target))) | Out-Null
    [System.IO.File]::Copy((Get-ExtendedPath $file.FullName), (Get-ExtendedPath $target), $true)
  }
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

function Get-PluginPackage {
  param([string]$Source)
  $manifestPath = Join-Path $Source 'package.json'
  $manifest = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  $name = [string](Get-ObjectProperty $manifest 'name')
  $version = [string](Get-ObjectProperty $manifest 'version')
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($version)) { throw "插件包缺少 name 或 version：$Source" }
  if ($name -notmatch '^(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$') { throw "插件包名不合法：$name" }
  foreach ($segment in $name.Split('/')) {
    if ($segment -eq '.' -or $segment -eq '..') { throw "插件包名不合法：$name" }
  }
  $slug = ($name -replace '^@', '') -replace '/', '-'
  return [pscustomobject]@{
    Name = $name
    Version = $version
    Slug = $slug
    Source = $Source
    Target = ''
    PosixTarget = ''
    InstallRoot = ''
    ReplaceExisting = $false
    Installed = $false
  }
}

function Install-PluginFiles {
  $pluginRoot = Join-Path $script:Root 'plugin'
  $packages = @(Get-ChildItem -LiteralPath $pluginRoot -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf })
  if ($packages.Count -ne 1) { Fail 'pluginMissing' }
  $plugin = Get-PluginPackage $packages[0].FullName
  $installRoot = Join-Path $script:LocalAppData 'DSH Industry Research'
  $target = Join-Path $installRoot ('plugin\' + $plugin.Version)
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-DirectoryTree $plugin.Source $target
  foreach ($name in @('Uninstall.cmd', 'Uninstall.ps1', 'messages.json', 'README.txt', 'THIRD-PARTY-NOTICES.txt', 'manifest.json')) {
    $sourceFile = Join-Path $script:Root $name
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
      Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $installRoot $name) -Force
    }
  }
  $plugin.Target = $target
  $plugin.PosixTarget = ($target -replace '\\', '/')
  $plugin.InstallRoot = $installRoot
  $plugin.ReplaceExisting = $true
  return $plugin
}

function Install-BundledPluginFiles {
  $bundledRoot = Join-Path $script:Root 'bundled-plugins'
  if (-not (Test-Path -LiteralPath $bundledRoot -PathType Container)) { return @() }
  $installRoot = Join-Path $script:LocalAppData 'DSH Industry Research'
  $plugins = New-Object System.Collections.Generic.List[object]
  foreach ($slugDir in @(Get-ChildItem -LiteralPath $bundledRoot -Directory -ErrorAction SilentlyContinue)) {
    foreach ($versionDir in @(Get-ChildItem -LiteralPath $slugDir.FullName -Directory -ErrorAction SilentlyContinue)) {
      if (-not (Test-Path -LiteralPath (Join-Path $versionDir.FullName 'package.json') -PathType Leaf)) { continue }
      $plugin = Get-PluginPackage $versionDir.FullName
      $target = Join-Path $installRoot ('bundled-plugins\' + $plugin.Slug + '\' + $plugin.Version)
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Copy-DirectoryTree $plugin.Source $target
      $plugin.Target = $target
      $plugin.PosixTarget = ($target -replace '\\', '/')
      $plugins.Add($plugin) | Out-Null
    }
  }
  return $plugins.ToArray()
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

function Read-DesktopProfile {
  param([string]$DshHome)
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

  return [pscustomobject]@{
    Directory = $profileDir
    ManifestPath = $manifestPath
    Manifest = $manifest
  }
}

function Get-PluginLinkPath {
  param([string]$NodeModules, [string]$Name)
  $segments = $Name.Split('/')
  if ($segments.Count -eq 2 -and $segments[0].StartsWith('@')) {
    return Join-Path (Join-Path $NodeModules $segments[0]) $segments[1]
  }
  return Join-Path $NodeModules $Name
}

function Remove-PluginLink {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  $linkType = [string](Get-ObjectProperty $item 'LinkType')
  if ($linkType -eq 'Junction' -or $linkType -eq 'SymbolicLink') {
    [System.IO.Directory]::Delete($Path, $false)
  } elseif ($item.PSIsContainer) {
    throw "Existing plugin directory is not a link: $Path"
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Update-DesktopProfile {
  param([string]$DshHome, $Plugins)
  $state = Read-DesktopProfile $DshHome
  $manifest = $state.Manifest

  $dependencies = Get-ObjectProperty $manifest 'dependencies'
  if ($null -eq $dependencies) {
    $dependencies = [pscustomobject]@{}
    Set-ObjectProperty $manifest 'dependencies' $dependencies
  }
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
  $patchPath = Join-Path $state.Directory 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    [System.IO.File]::WriteAllText($patchPath, "[]`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  $workspacePath = Join-Path $state.Directory 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $workspacePath -PathType Leaf)) {
    $workspace = "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n"
    [System.IO.File]::WriteAllText($workspacePath, $workspace, (New-Object System.Text.UTF8Encoding($false)))
  }

  $nodeModules = Join-Path $state.Directory 'node_modules'
  New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
  $installed = New-Object System.Collections.Generic.List[object]
  foreach ($plugin in @($Plugins)) {
    if ($null -eq $plugin) { continue }
    $existing = $dependencies.PSObject.Properties[$plugin.Name]
    $managedPrefix = 'link:' + ((Join-Path $script:LocalAppData ('DSH Industry Research\bundled-plugins\' + $plugin.Slug + '\')) -replace '\\', '/')
    $replace = [bool]$plugin.ReplaceExisting
    if ($null -ne $existing) {
      $existingValue = [string]$existing.Value
      if (-not $replace -and -not $existingValue.StartsWith($managedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Log ('Keeping existing plugin dependency: ' + $plugin.Name + ' = ' + $existingValue)
        continue
      }
      $replace = $true
    }
    if ($null -eq $existing -or $replace) {
      $linkPath = Get-PluginLinkPath $nodeModules $plugin.Name
      $parent = Split-Path -Parent $linkPath
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      Remove-PluginLink $linkPath
      New-Item -ItemType Junction -Path $linkPath -Target $plugin.Target | Out-Null
      Set-ObjectProperty $dependencies $plugin.Name ('link:' + $plugin.PosixTarget)
      if ($bundles -notcontains $plugin.Name) { $bundles += $plugin.Name }
      $plugin.Installed = $true
      $installed.Add($plugin) | Out-Null
      Write-Log ('Linked plugin ' + $plugin.Name + '@' + $plugin.Version + ' at ' + $linkPath)
    }
  }
  Set-ObjectProperty $profile 'bundles' $bundles
  Write-JsonFile $state.ManifestPath $manifest
  return [pscustomobject]@{
    ProfileDir = $state.Directory
    Installed = $installed.ToArray()
  }
}

try {
  $script:Messages = Read-Messages
  Write-Log 'Installer started.'
  if ($script:TestMode) {
    if ([string]::IsNullOrWhiteSpace($script:LocalAppData)) { throw 'LOCALAPPDATA is not set.' }
    $script:LocalAppData = Join-Path $script:TestRoot 'LocalAppData'
    New-Item -ItemType Directory -Path $script:LocalAppData -Force | Out-Null
  }
  $compatibility = Get-InstallerCompatibility -UseTestOverrides:$script:TestMode
  Write-Log ('Detected system: ' + $compatibility.Detail)
  if (-not $compatibility.Supported) { Fail $compatibility.ReasonKey $compatibility.Detail }

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
  $bundledPlugins = @(Install-BundledPluginFiles)
  $profileState = Update-DesktopProfile -DshHome $dshHome -Plugins (@($plugin) + $bundledPlugins)
  $profileDir = $profileState.ProfileDir
  $installedPlugins = @($profileState.Installed)
  $marker = [pscustomobject]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    plugins = @($installedPlugins | ForEach-Object {
      [pscustomobject]@{ name = $_.Name; version = $_.Version; target = $_.Target; posixTarget = $_.PosixTarget }
    })
  }
  Write-JsonFile (Join-Path $plugin.InstallRoot 'installed-plugins.json') $marker
  Write-Log ('Plugin installed at ' + $plugin.Target)
  foreach ($installedPlugin in $installedPlugins) { Write-Log ('Bundled plugin ' + $installedPlugin.Name + '@' + $installedPlugin.Version + ' at ' + $installedPlugin.Target) }
  Write-Log ('Desktop profile updated at ' + $profileDir)

  if ($script:TestMode) {
    $result = [pscustomobject]@{
      status = 'installed'
      pluginVersion = $plugin.Version
      pluginPath = $plugin.Target
      bundledPlugins = @($installedPlugins | Where-Object { $_.Name -ne $plugin.Name } | ForEach-Object { [pscustomobject]@{ name = $_.Name; version = $_.Version; target = $_.Target } })
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
  Fail 'installFailed' ($_.Exception.Message + "`r`n" + $_.ScriptStackTrace)
}
