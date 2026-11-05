import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(root, 'artifacts');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const desktopVersion = '0.2.0-rc.2';
const targetOS = 'Windows 10/11';
const targetArch = 'x64';
const pluginDir = resolve(artifacts, `${pkg.name}-${version}`);
const pluginManifest = resolve(pluginDir, 'package.json');
if (!existsSync(pluginManifest)) throw new Error(`缺少插件安装目录：${pluginDir}。请先运行 npm run plugin:pack`);
if (JSON.parse(readFileSync(pluginManifest, 'utf8')).version !== version) throw new Error('插件安装目录版本与 package.json 不一致，请重新打包插件');
const bundledRoot = resolve(artifacts, 'bundled-plugins');
const bundledManifestPath = resolve(bundledRoot, 'manifest.json');
if (!existsSync(bundledManifestPath)) throw new Error('缺少预装插件目录。请先运行 npm run bundle:plugins');
const bundledRelease = JSON.parse(readFileSync(bundledManifestPath, 'utf8'));
for (const plugin of bundledRelease.plugins ?? []) {
  const directory = resolve(bundledRoot, plugin.slug, plugin.version);
  if (!existsSync(resolve(directory, 'package.json'))) throw new Error(`预装插件不完整：${plugin.name}@${plugin.version}`);
}

const officialInstaller = process.env.DSH_DESKTOP_INSTALLER ?? join(process.env.LOCALAPPDATA ?? '', '@deepseek-aidsh-desktop-updater', 'installer.exe');
if (!existsSync(officialInstaller)) throw new Error(`找不到 DeepSeek Harness 官方安装器：${officialInstaller}。请设置 DSH_DESKTOP_INSTALLER`);
const makensisCandidates = [process.env.MAKENSIS, 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].filter(Boolean);
const makensis = makensisCandidates.find(path => existsSync(path));
if (!makensis) throw new Error('找不到 NSIS makensis.exe。请安装 NSIS 或设置 MAKENSIS');

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} 执行失败：${result.status}`);
  return result.stdout;
}

function verifyOfficialInstaller() {
  const escaped = officialInstaller.replaceAll("'", "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid') { Write-Error ('签名无效：' + $s.Status); exit 1 }; Write-Output $s.Status`;
  for (const shell of [process.env.POWERSHELL, 'pwsh.exe', 'powershell.exe'].filter(Boolean)) {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return result.stdout.trim();
  }
  console.warn('警告：当前环境无法调用 Authenticode 签名校验，继续使用官方安装器。可用 DSH_DESKTOP_INSTALLER_SHA256 额外校验文件哈希。');
  return 'unverified';
}

const officialSha256 = sha256File(officialInstaller);
if (process.env.DSH_DESKTOP_INSTALLER_SHA256 && process.env.DSH_DESKTOP_INSTALLER_SHA256.toLowerCase() !== officialSha256) {
  throw new Error('DeepSeek Harness 官方安装器 SHA256 与 DSH_DESKTOP_INSTALLER_SHA256 不一致');
}
const signatureStatus = process.env.SKIP_DSH_SIGNATURE_CHECK === '1' ? 'skipped' : verifyOfficialInstaller();
const stage = resolve(artifacts, 'windows-bundle-stage');
const nsi = resolve(artifacts, 'windows-bundle.nsi');
const installerFilename = `DSH-Industry-Research-Windows-Setup-v${version}-${targetArch}.exe`;
const output = resolve(artifacts, installerFilename);
rmSync(stage, { recursive: true, force: true });
rmSync(nsi, { force: true });
rmSync(output, { force: true });
mkdirSync(stage, { recursive: true });

try {
  const installerFiles = resolve(root, 'installer/windows');
  cpSync(installerFiles, stage, {
    recursive: true,
    filter: source => !source.endsWith('README.template.txt') && !source.endsWith('README.txt')
  });
  copyFileSync(officialInstaller, resolve(stage, 'DeepSeek-Harness-Setup.exe'));
  cpSync(pluginDir, resolve(stage, 'plugin', basename(pluginDir)), { recursive: true });
  for (const plugin of bundledRelease.plugins ?? []) {
    cpSync(resolve(bundledRoot, plugin.slug, plugin.version), resolve(stage, 'bundled-plugins', plugin.slug, plugin.version), { recursive: true });
  }

  const readmeTemplate = readFileSync(resolve(installerFiles, 'README.template.txt'), 'utf8');
  writeFileSync(resolve(stage, 'README.txt'), readmeTemplate
    .replaceAll('{{PLUGIN_VERSION}}', version)
    .replaceAll('{{DESKTOP_VERSION}}', desktopVersion)
    .replaceAll('{{INSTALLER_FILENAME}}', installerFilename)
    .replaceAll('{{TARGET_OS}}', targetOS)
    .replaceAll('{{TARGET_ARCH}}', targetArch));

  const release = existsSync(resolve(artifacts, 'plugin-release.json')) ? JSON.parse(readFileSync(resolve(artifacts, 'plugin-release.json'), 'utf8')) : {};
  const metadata = {
    bundle: 'dsh-industry-research-windows',
    target: { os: targetOS, architecture: targetArch },
    plugin: { name: pkg.name, version, directory: basename(pluginDir), tgz: release.filename, sha256: release.sha256 },
    bundledPlugins: (bundledRelease.plugins ?? []).map(plugin => ({ name: plugin.name, version: plugin.version, license: plugin.license, homepage: plugin.homepage, sourceUrl: plugin.sourceUrl, sha256: plugin.sha256 })),
    deepseekHarness: { version: desktopVersion, architecture: targetArch, minimumOS: targetOS, installer: 'DeepSeek-Harness-Setup.exe', sha256: officialSha256, signature: signatureStatus },
    builtAt: new Date().toISOString()
  };
  writeFileSync(resolve(stage, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');

  const script = `Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!define PRODUCT_NAME "DSH 行研工作台"
!define PRODUCT_VERSION "${version}"
!define PRODUCT_PUBLISHER "DSH Industry Research"
!define PRODUCT_URL "https://github.com/zaki-zeyi/dsh-industry-research"
!define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7D83B2E5-2D8F-4B2A-9D8A-3A4E1C7B6F10}"
!define INSTALLER_MUTEX "Local\\DSH-Industry-Research-Installer-{7D83B2E5-2D8F-4B2A-9D8A-3A4E1C7B6F10}"
!define SETUP_CAPTION "DSH 行研工作台 安装程序（Windows 10/11 x64）"
!define UNINSTALL_CAPTION "DSH 行研工作台 卸载程序"
Var UninstallRegistryKey

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 DSH 行研工作台"
!define MUI_WELCOMEPAGE_TEXT "此向导将安装 DeepSeek Harness（如未安装）、行研工作台和精选插件。安装仅写入当前用户目录，不需要管理员权限。"
!define MUI_FINISHPAGE_TITLE "DSH 行研工作台安装完成"
!define MUI_FINISHPAGE_TEXT "安装已完成。你可以从开始菜单或桌面打开 DeepSeek Harness。"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 DeepSeek Harness"
!define MUI_FINISHPAGE_RUN_PARAMETERS "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\\"$INSTDIR\\Launch DSH.ps1$\\""

Name "\${PRODUCT_NAME}（Windows 10/11 x64）"
Caption "\${SETUP_CAPTION}"
UninstallCaption "\${UNINSTALL_CAPTION}"
BrandingText "\${PRODUCT_NAME} v\${PRODUCT_VERSION}"
OutFile "${output}"
RequestExecutionLevel user
SetCompressor /SOLID zlib
ShowInstDetails show
AutoCloseWindow false
AllowSkipFiles off
InstallDir "$LOCALAPPDATA\\DSH Industry Research"
InstallDirRegKey HKCU "\${UNINSTALL_KEY}" "InstallLocation"
VIProductVersion "${version}.0"
VIAddVersionKey "ProductName" "\${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "\${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "\${PRODUCT_NAME} Windows 10/11 x64 一键安装包"
VIAddVersionKey "FileVersion" "\${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "\${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) DSH Industry Research"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!define SYSTYPE_PTR p

!macro ActivateOtherInstance
  StrCpy $3 ""
  loop:
    FindWindow $3 "#32770" "" "" $3
    StrCmp 0 $3 windownotfound
    StrLen $0 "\${SETUP_CAPTION}"
    IntOp $0 $0 + 1
    System::Call 'USER32::GetWindowText(p r3, t.r0, i r0)'
    StrCmp $0 "\${SETUP_CAPTION}" windowfound ""
    StrLen $0 "\${UNINSTALL_CAPTION}"
    IntOp $0 $0 + 1
    System::Call 'USER32::GetWindowText(p r3, t.r0, i r0)'
    StrCmp $0 "\${UNINSTALL_CAPTION}" windowfound loop
  windowfound:
    SendMessage $3 0x112 0xF120 0 /TIMEOUT=2000
    System::Call 'USER32::SetForegroundWindow(p r3)'
  windownotfound:
!macroend

!macro SingleInstanceMutex
  System::Call 'KERNEL32::CreateMutex(p 0, i 1, t "\${INSTALLER_MUTEX}") p .r9 ?e'
  StrCmp $9 0 mutexFailed createOk
  mutexFailed:
    SetErrorLevel 3
    Abort
  createOk:
  Pop $0
  IntCmpU $0 183 duplicate launch launch
  duplicate:
    IfSilent silentDuplicate
    !insertmacro ActivateOtherInstance
    SetErrorLevel 2
    Abort
  silentDuplicate:
    SetErrorLevel 2
    Abort
  launch:
!macroend

Function .onInit
  SetShellVarContext current
  !insertmacro SingleInstanceMutex
  StrCpy $UninstallRegistryKey "\${UNINSTALL_KEY}"
  ReadEnvStr $0 "DSH_BUNDLE_TEST_ROOT"
  \${If} $0 != ""
    StrCpy $INSTDIR "$0\\LocalAppData\\DSH Industry Research"
    StrCpy $UninstallRegistryKey "\${UNINSTALL_KEY}-Test"
  \${EndIf}
  \${IfNot} \${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "此安装包仅支持 Windows 10 或 Windows 11（64 位）。当前系统版本过低，请升级后再安装。" /SD IDOK
    SetErrorLevel 2
    Abort
  \${EndIf}
  \${IfNot} \${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包包含 64 位 DeepSeek Harness 桌面端，不能在 32 位 Windows 或 ARM64 系统上安装。请使用 64 位 Windows 10/11。" /SD IDOK
    SetErrorLevel 2
    Abort
  \${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  !insertmacro SingleInstanceMutex
  StrCpy $UninstallRegistryKey "\${UNINSTALL_KEY}"
  ReadEnvStr $0 "DSH_BUNDLE_TEST_ROOT"
  \${If} $0 != ""
    StrCpy $INSTDIR "$0\\LocalAppData\\DSH Industry Research"
    StrCpy $UninstallRegistryKey "\${UNINSTALL_KEY}-Test"
  \${EndIf}
FunctionEnd

Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\\payload"
  File /r "${stage}\\*.*"
  DetailPrint "正在配置行研工作台..."
  StrCpy $1 "-NoLaunch -NoSuccessDialog"
  IfSilent 0 +2
    StrCpy $1 "$1 -Silent"
  ExecWait '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\\payload\\Install.ps1" $1' $0
  IntCmp $0 0 installSucceeded
    SetErrorLevel $0
    MessageBox MB_OK|MB_ICONSTOP "安装未完成。请查看日志：$TEMP\\dsh-industry-research-bundle.log" /SD IDOK
    Abort
  installSucceeded:
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "$UninstallRegistryKey" "DisplayName" "\${PRODUCT_NAME}"
  WriteRegStr HKCU "$UninstallRegistryKey" "DisplayVersion" "\${PRODUCT_VERSION}"
  WriteRegStr HKCU "$UninstallRegistryKey" "Publisher" "\${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "$UninstallRegistryKey" "URLInfoAbout" "\${PRODUCT_URL}"
  WriteRegStr HKCU "$UninstallRegistryKey" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "$UninstallRegistryKey" "DisplayIcon" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "$UninstallRegistryKey" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "$UninstallRegistryKey" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'
  WriteRegDWORD HKCU "$UninstallRegistryKey" "NoModify" 1
  WriteRegDWORD HKCU "$UninstallRegistryKey" "NoRepair" 1
  DetailPrint "安装完成。"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\\Uninstall.ps1" 0 uninstallMissing
  DetailPrint "正在移除行研工作台和本安装包添加的插件..."
  ExecWait '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\\Uninstall.ps1" -Silent -NoConfirm' $0
  IntCmp $0 0 uninstallSucceeded
    SetErrorLevel $0
    MessageBox MB_OK|MB_ICONSTOP "卸载未完成。请查看日志：$TEMP\\dsh-industry-research-bundle.log" /SD IDOK
    Abort
  uninstallMissing:
    SetErrorLevel 3
    MessageBox MB_OK|MB_ICONSTOP "卸载程序文件缺失。请重新运行最新安装包修复后再卸载。" /SD IDOK
    Abort
  uninstallSucceeded:
  Delete "$INSTDIR\\Launch DSH.ps1"
  Delete "$INSTDIR\\Uninstall.ps1"
  Delete "$INSTDIR\\Uninstall.cmd"
  Delete "$INSTDIR\\messages.json"
  Delete "$INSTDIR\\README.txt"
  Delete "$INSTDIR\\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\\manifest.json"
  Delete "$INSTDIR\\installed-plugins.json"
  RMDir /r "$INSTDIR\\plugin"
  RMDir /r "$INSTDIR\\bundled-plugins"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "$UninstallRegistryKey"
  DetailPrint "卸载完成。"
SectionEnd
`;
  writeFileSync(nsi, '\ufeff' + script, 'utf8');
  run(makensis, ['/V4', nsi]);

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  writeFileSync(`${output}.sha256`, `${sha256}  ${basename(output)}\n`);
  writeFileSync(resolve(artifacts, 'windows-bundle.json'), JSON.stringify({ ...metadata, filename: basename(output), size: statSync(output).size, sha256 }, null, 2) + '\n');
  console.log(`Windows 一键安装包：${output}`);
  console.log(`大小：${(statSync(output).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`SHA256：${sha256}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(nsi, { force: true });
}
