Set-StrictMode -Version Latest

function Get-EffectiveWindowsArchitecture {
  param(
    [string]$ProcessorArchitecture = $env:PROCESSOR_ARCHITECTURE,
    [string]$ProcessorArchitectureWow = $env:PROCESSOR_ARCHITEW6432
  )

  $architecture = $ProcessorArchitecture
  if (-not [string]::IsNullOrWhiteSpace($ProcessorArchitectureWow)) {
    $architecture = $ProcessorArchitectureWow
  }
  if ([string]::IsNullOrWhiteSpace($architecture)) { return 'UNKNOWN' }
  return $architecture.Trim().ToUpperInvariant()
}

function Get-WindowsReleaseInfo {
  param(
    [Nullable[int]]$BuildNumber,
    [string]$ProductName = ''
  )

  if ($null -eq $BuildNumber) {
    $version = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    $parsedBuild = 0
    if (-not [int]::TryParse([string]$version.CurrentBuildNumber, [ref]$parsedBuild)) {
      throw 'Unable to read the Windows build number.'
    }
    $BuildNumber = $parsedBuild
    if ([string]::IsNullOrWhiteSpace($ProductName)) {
      $ProductName = [string]$version.ProductName
    }
  }

  $name = if ($ProductName -match '(?i)\bServer\b') {
    'Windows Server'
  } elseif ($BuildNumber -ge 22000) {
    'Windows 11'
  } elseif ($BuildNumber -ge 10240) {
    'Windows 10'
  } else {
    'Windows 8.1 or earlier'
  }

  return [pscustomobject]@{
    Name = $name
    Build = [int]$BuildNumber
    ProductName = $ProductName
  }
}

function Get-InstallerCompatibility {
  param(
    [switch]$UseTestOverrides,
    [Nullable[int]]$BuildNumber,
    [string]$ProductName = '',
    [string]$Architecture = '',
    [Nullable[bool]]$Is64BitOperatingSystem
  )

  $resolvedBuild = $BuildNumber
  $resolvedProduct = $ProductName
  $resolvedArchitecture = $Architecture
  $resolvedIs64Bit = $Is64BitOperatingSystem

  if ($UseTestOverrides) {
    if ($null -eq $resolvedBuild -and -not [string]::IsNullOrWhiteSpace($env:DSH_BUNDLE_TEST_OS_BUILD)) {
      $resolvedBuild = [int]$env:DSH_BUNDLE_TEST_OS_BUILD
    }
    if ([string]::IsNullOrWhiteSpace($resolvedProduct) -and -not [string]::IsNullOrWhiteSpace($env:DSH_BUNDLE_TEST_OS_PRODUCT)) {
      $resolvedProduct = $env:DSH_BUNDLE_TEST_OS_PRODUCT
    }
    if ([string]::IsNullOrWhiteSpace($resolvedArchitecture) -and -not [string]::IsNullOrWhiteSpace($env:DSH_BUNDLE_TEST_ARCH)) {
      $resolvedArchitecture = $env:DSH_BUNDLE_TEST_ARCH
    }
    if ($null -eq $resolvedIs64Bit -and -not [string]::IsNullOrWhiteSpace($env:DSH_BUNDLE_TEST_IS64BIT_OS)) {
      $resolvedIs64Bit = $env:DSH_BUNDLE_TEST_IS64BIT_OS -notin @('0', 'false', 'False')
    }
  }

  if ([string]::IsNullOrWhiteSpace($resolvedArchitecture)) {
    $resolvedArchitecture = Get-EffectiveWindowsArchitecture
  }
  if ($null -eq $resolvedIs64Bit) {
    $resolvedIs64Bit = [Environment]::Is64BitOperatingSystem
  }

  $release = Get-WindowsReleaseInfo -BuildNumber $resolvedBuild -ProductName $resolvedProduct
  $displayArchitecture = switch ($resolvedArchitecture) {
    'AMD64' { 'x64' }
    'X64' { 'x64' }
    'ARM64' { 'ARM64' }
    'X86' { 'x86 (32-bit)' }
    default { $resolvedArchitecture }
  }
  $detail = '{0} (build {1}, {2})' -f $release.Name, $release.Build, $displayArchitecture
  if (-not [string]::IsNullOrWhiteSpace($release.ProductName)) {
    $detail = $detail + ' - ' + $release.ProductName
  }

  $reasonKey = ''
  if ($release.Build -lt 10240) {
    $reasonKey = 'unsupportedOS'
  } elseif ($release.ProductName -match '(?i)\bServer\b') {
    $reasonKey = 'unsupportedServerOS'
  } elseif (-not $resolvedIs64Bit) {
    $reasonKey = 'unsupportedArch'
  } elseif ($resolvedArchitecture -eq 'ARM64') {
    $reasonKey = 'unsupportedArm64'
  } elseif ($resolvedArchitecture -notin @('AMD64', 'X64')) {
    $reasonKey = 'unsupportedArch'
  }

  return [pscustomobject]@{
    Supported = [string]::IsNullOrWhiteSpace($reasonKey)
    ReasonKey = $reasonKey
    Name = $release.Name
    Build = $release.Build
    Architecture = $displayArchitecture
    Detail = $detail
  }
}
