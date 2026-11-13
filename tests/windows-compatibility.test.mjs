import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compatibilityScript = fileURLToPath(new URL('../installer/windows/Compatibility.ps1', import.meta.url));

test('Windows 安装器只允许 Windows 10/11 x64', { skip: process.platform !== 'win32' }, () => {
  const escaped = compatibilityScript.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
. '${escaped}'
$cases = @(
  @{ Build = 19045; Product = 'Microsoft Windows 10 Pro'; Arch = 'AMD64'; Is64 = $true },
  @{ Build = 22631; Product = 'Microsoft Windows 11 Pro'; Arch = 'AMD64'; Is64 = $true },
  @{ Build = 7601; Product = 'Microsoft Windows 7'; Arch = 'AMD64'; Is64 = $true },
  @{ Build = 19045; Product = 'Microsoft Windows 10 Home'; Arch = 'X86'; Is64 = $false },
  @{ Build = 20348; Product = 'Windows Server 2022'; Arch = 'AMD64'; Is64 = $true },
  @{ Build = 22631; Product = 'Microsoft Windows 11 Pro'; Arch = 'ARM64'; Is64 = $true }
)
@($cases | ForEach-Object {
  $result = Get-InstallerCompatibility -BuildNumber $_.Build -ProductName $_.Product -Architecture $_.Arch -Is64BitOperatingSystem $_.Is64
  [pscustomobject]@{ Supported = $result.Supported; ReasonKey = $result.ReasonKey; Name = $result.Name }
}) | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [
    { Supported: true, ReasonKey: '', Name: 'Windows 10' },
    { Supported: true, ReasonKey: '', Name: 'Windows 11' },
    { Supported: false, ReasonKey: 'unsupportedOS', Name: 'Windows 8.1 or earlier' },
    { Supported: false, ReasonKey: 'unsupportedArch', Name: 'Windows 10' },
    { Supported: false, ReasonKey: 'unsupportedServerOS', Name: 'Windows Server' },
    { Supported: false, ReasonKey: 'unsupportedArm64', Name: 'Windows 11' }
  ]);
});
