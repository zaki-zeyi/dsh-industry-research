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
const output = resolve(artifacts, `DSH-Industry-Research-Windows-Setup-v${version}.exe`);
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
  writeFileSync(resolve(stage, 'README.txt'), readmeTemplate.replaceAll('{{PLUGIN_VERSION}}', version).replaceAll('{{DESKTOP_VERSION}}', desktopVersion));

  const release = existsSync(resolve(artifacts, 'plugin-release.json')) ? JSON.parse(readFileSync(resolve(artifacts, 'plugin-release.json'), 'utf8')) : {};
  const metadata = {
    bundle: 'dsh-industry-research-windows',
    plugin: { name: pkg.name, version, directory: basename(pluginDir), tgz: release.filename, sha256: release.sha256 },
    bundledPlugins: (bundledRelease.plugins ?? []).map(plugin => ({ name: plugin.name, version: plugin.version, license: plugin.license, homepage: plugin.homepage, sourceUrl: plugin.sourceUrl, sha256: plugin.sha256 })),
    deepseekHarness: { version: desktopVersion, installer: 'DeepSeek-Harness-Setup.exe', sha256: officialSha256, signature: signatureStatus },
    builtAt: new Date().toISOString()
  };
  writeFileSync(resolve(stage, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');

  const script = `Unicode true
ManifestDPIAware true
Name "DSH 行研工作台"
Caption "DSH 行研工作台 安装程序"
BrandingText "DSH 行研工作台 v${version}"
OutFile "${output}"
RequestExecutionLevel user
SetCompressor /SOLID zlib
ShowInstDetails show
AutoCloseWindow true
VIProductVersion "${version}.0"
VIAddVersionKey "ProductName" "DSH 行研工作台"
VIAddVersionKey "FileDescription" "DSH 行研工作台 Windows 一键安装包"
VIAddVersionKey "FileVersion" "${version}"

Page instfiles

Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\\payload"
  File /r "${stage}\\*.*"
  DetailPrint "正在配置行研工作台..."
  ExecWait '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\\payload\\Install.ps1"' $0
  IntCmp $0 0 done
    MessageBox MB_ICONSTOP "安装未完成。请查看日志：$TEMP\\dsh-industry-research-bundle.log"
  done:
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
