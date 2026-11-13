import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const installer = resolve(root, 'artifacts', `DSH-Industry-Research-Windows-Setup-v${version}-x64.exe`);
if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}. Run npm run bundle:windows first.`);
const script = resolve(root, 'scripts', 'installer-windows-acceptance.ps1');
const resultPath = resolve(root, 'artifacts', 'installer-acceptance.json');
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-Installer', installer, '-ResultPath', resultPath
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
