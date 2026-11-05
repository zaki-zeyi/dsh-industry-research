Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = $PSScriptRoot
$script:LogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-industry-research-bundle.log'
$script:TestRoot = $env:DSH_BUNDLE_TEST_ROOT
$script:TestMode = -not [string]::IsNullOrWhiteSpace($script:TestRoot)
$script:Messages = $null

function Read-Messages {
  $path = Join-Path $script:Root 'messages.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "messages.json is missing: $path" }
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
  try { Add-Content -LiteralPath $script:LogPath -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -Encoding UTF8 } catch { }
}

function Show-Message {
  param([string]$Text, [string]$Icon = 'Information')
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($Text, (T 'uninstallTitle'), 'OK', $Icon) | Out-Null
  } catch { }
}

function Ask-YesNo {
  param([string]$Text)
  Add-Type -AssemblyName System.Windows.Forms
  $answer = [System.Windows.Forms.MessageBox]::Show($Text, (T 'uninstallTitle'), 'YesNo', 'Question')
  return $answer -eq [System.Windows.Forms.DialogResult]::Yes
}

function Fail {
  param([string]$Key, [string]$Detail = '')
  $text = T $Key
  if (-not [string]::IsNullOrWhiteSpace($Detail)) { $text = $text + "`r`n`r`n" + $Detail }
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
  if ($null -eq $property) { $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value }
  else { $Object.$Name = $Value }
}

function Write-JsonFile {
  param([string]$Path, $Object)
  $json = $Object | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

try {
  $script:Messages = Read-Messages
  Write-Log 'Uninstaller started.'
  if (-not $script:TestMode -and -not (Ask-YesNo (T 'uninstallConfirm'))) { exit 0 }

  $userHome = [Environment]::GetFolderPath('UserProfile')
  $dshHome = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = Join-Path $userHome '.dsh' }
  if ($script:TestMode) { $dshHome = Join-Path $script:TestRoot '.dsh' }
  $profileDir = Join-Path $dshHome 'profiles\desktop'
  $manifestPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail 'uninstallMissing' }

  try {
    $text = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
    $manifest = $text | ConvertFrom-Json
  } catch {
    Fail 'uninstallProfileInvalid' ($manifestPath + "`r`n" + $_.Exception.Message)
  }
  if ($null -eq $manifest -or $manifest -isnot [pscustomobject]) { Fail 'uninstallProfileInvalid' $manifestPath }

  $backup = $manifestPath + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item -LiteralPath $manifestPath -Destination $backup -Force

  $dependencies = Get-ObjectProperty $manifest 'dependencies'
  if ($null -ne $dependencies) {
    $dependency = $dependencies.PSObject.Properties['dsh-industry-research']
    if ($null -ne $dependency) { $dependencies.PSObject.Properties.Remove('dsh-industry-research') }
  }
  $dsh = Get-ObjectProperty $manifest 'dsh'
  $profile = Get-ObjectProperty $dsh 'profile'
  $bundlesValue = Get-ObjectProperty $profile 'bundles'
  if ($null -ne $bundlesValue) {
    $bundles = @($bundlesValue | ForEach-Object { [string]$_ } | Where-Object { $_ -ne 'dsh-industry-research' })
    Set-ObjectProperty $profile 'bundles' $bundles
  }
  Write-JsonFile $manifestPath $manifest

  $linkPath = Join-Path $profileDir 'node_modules\dsh-industry-research'
  if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $linkType = [string](Get-ObjectProperty $item 'LinkType')
    if ($linkType -eq 'Junction' -or $linkType -eq 'SymbolicLink') {
      [System.IO.Directory]::Delete($linkPath, $false)
    } else {
      Write-Log ('Left non-link directory untouched: ' + $linkPath)
    }
  }
  Write-Log ('Removed plugin from profile ' + $profileDir)
  if ($script:TestMode) {
    Write-Host (T 'uninstallDone') -ForegroundColor Green
    exit 0
  }
  Show-Message (T 'uninstallDone') 'Information'
  exit 0
} catch {
  Fail 'uninstallFailed' $_.Exception.Message
}
