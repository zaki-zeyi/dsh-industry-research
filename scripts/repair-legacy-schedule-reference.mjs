import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Repair the linked package's declaration, never the managed profile or the
// official Schedule bundle. The host re-reads this file before removal.
export function repairLegacyScheduleReference(packageRoot) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-industry-research' || manifest.dsh?.bundle?.patch !== './plugin/cordis.patch.yml') throw new Error('目标不是可识别的行研插件包');
  const file = resolve(root, 'plugin/cordis.patch.yml');
  const source = readFileSync(file, 'utf8');
  const expected = "- insert:\n    - id: dsh-industry-research\n      name: dsh-industry-research";
  const normalized = source.replaceAll('\r\n', '\n').trim();
  if (normalized === expected) return { repaired: false, alreadyClean: true };
  const legacy = expected + "\n\n- insert:\n    - id: schedule\n      name: '@deepseek-ai/dsh-schedule'";
  if (normalized !== legacy) throw new Error('声明包含其他配置，未自动改写；需要人工核对');
  const backup = file + '.before-schedule-ownership-fix';
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, expected + '\n');
  return { repaired: true, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--package-root');
  if (at < 0 || !process.argv[at + 1]) throw new Error('请用 --package-root 指定旧行研插件目录');
  console.log(JSON.stringify(repairLegacyScheduleReference(process.argv[at + 1])));
}
