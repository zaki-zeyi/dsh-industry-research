import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

for (const fault of ['stale-version', 'tampered-archive', 'wrong-directory']) {
  test(`release publication rejects ${fault} before updating Git`, () => {
    const root = mkdtempSync(resolve(tmpdir(), 'release-integrity-'));
    try {
      mkdirSync(resolve(root, 'scripts'));
      mkdirSync(resolve(root, 'artifacts/package'), { recursive: true });
      copyFileSync(new URL('../scripts/publish-git-plugin.mjs', import.meta.url), resolve(root, 'scripts/publish.mjs'));
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      writeFileSync(resolve(root, 'artifacts/package/package.json'), JSON.stringify({ version: fault === 'wrong-directory' ? '0.1.1' : '1.2.3' }));
      const hash = createHash('sha256').update('verified').digest('hex');
      for (const file of ['package.tgz', 'package.zip']) writeFileSync(resolve(root, 'artifacts', file), fault === 'tampered-archive' ? 'changed' : 'verified');
      writeFileSync(resolve(root, 'artifacts/plugin-release.json'), JSON.stringify({ version: fault === 'stale-version' ? '0.1.1' : '1.2.3', filename: 'package.tgz', sha256: hash, zipFilename: 'package.zip', zipSha256: hash, directory: 'package' }));
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/publish.mjs'), '--output', resolve(root, 'output')], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /AssertionError/);
      assert.doesNotMatch(result.stderr, /Git 提交身份|remote.*origin/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
