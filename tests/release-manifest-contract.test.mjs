import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
test('shared development/install manifest bundles all runtime dependencies without lifecycle hooks', () => {
  assert.deepEqual([...manifest.bundledDependencies].sort(), Object.keys(manifest.dependencies).sort());
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish']) {
    assert.ok(!manifest.scripts?.[hook], `unsafe lifecycle hook: ${hook}`);
  }
  for (const dependency of ['react', 'react-dom', '@xterm/xterm', 'vite']) {
    assert.ok(manifest.devDependencies[dependency], `${dependency} is already bundled in dist`);
    assert.equal(manifest.dependencies[dependency], undefined);
  }
  assert.ok(!manifest.files.includes('scripts'));
  for (const name of ['prepare-pty.mjs', 'terminal-turn-notify.mjs', 'repair-legacy-schedule-reference.mjs']) assert.ok(manifest.files.includes(`scripts/${name}`));
});
