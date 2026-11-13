import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const buildScript = readFileSync(new URL('../scripts/build-windows-bundle.mjs', import.meta.url), 'utf8');
const installScript = readFileSync(new URL('../installer/windows/Install.ps1', import.meta.url), 'utf8');
const uninstallScript = readFileSync(new URL('../installer/windows/Uninstall.ps1', import.meta.url), 'utf8');

test('Windows installer enforces a single install/uninstall instance', () => {
  assert.match(buildScript, /CreateMutex/);
  assert.match(buildScript, /INSTALLER_MUTEX/);
  assert.match(buildScript, /IntCmpU \$0 183/);
  assert.match(buildScript, /!insertmacro SingleInstanceMutex/);
  assert.match(buildScript, /Function un\.onInit/);
});

test('Windows installer registers a standard per-user uninstall entry', () => {
  assert.match(buildScript, /WriteUninstaller .*Uninstall\.exe/);
  assert.match(buildScript, /QuietUninstallString/);
  assert.match(buildScript, /NoModify/);
  assert.match(buildScript, /NoRepair/);
  assert.match(buildScript, /InstallLocation/);
  assert.match(buildScript, /DisplayVersion/);
});

test('Windows installer supports fully silent operation and non-zero failures', () => {
  assert.match(buildScript, /IfSilent/);
  assert.match(buildScript, /-Silent/);
  assert.match(buildScript, /\/SD IDOK/);
  assert.match(buildScript, /SetErrorLevel/);
  assert.match(installScript, /\[switch\]\$Silent/);
  assert.match(installScript, /if \(\$script:Silent\) \{ return \}/);
  assert.match(uninstallScript, /\[switch\]\$Silent/);
  assert.match(uninstallScript, /\[switch\]\$NoConfirm/);
});

test('Windows installer keeps a generated DSH launch command for the finish page', () => {
  assert.match(installScript, /function Write-LaunchScript/);
  assert.match(installScript, /Launch DSH\.ps1/);
  assert.match(buildScript, /MUI_FINISHPAGE_RUN/);
});

test('Windows installer sources are committed without machine-specific artifacts', () => {
  assert.doesNotMatch(buildScript, /C:\\\\Users\\\\/i);
  assert.doesNotMatch(installScript, /C:\\\\Users\\\\/i);
  assert.doesNotMatch(uninstallScript, /C:\\\\Users\\\\/i);
});
