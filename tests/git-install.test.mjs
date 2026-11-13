import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
test('GitHub安装契约：入口存在，且不要求安装时构建、准备或打包', () => {
 const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
 assert.equal(manifest.name, 'dsh-industry-research');assert.ok(existsSync(resolve(root, manifest.main)));assert.ok(existsSync(resolve(root, manifest.exports['.'])));
 for(const hook of ['prepare','prepack','prepublish','publish','preinstall','install','postinstall'])assert.ok(!manifest.scripts?.[hook], `禁止安装生命周期：${hook}`);
});
test('GitHub安装契约：页面与其引用的预构建资源完整存在', () => {
 const file=resolve(root,'dist/index.html'),html=readFileSync(file,'utf8');const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m=>m[1]);assert.ok(assets.length>=2);
 for(const asset of assets)assert.ok(existsSync(resolve(dirname(file),'.'+asset)),`缺少预构建资源 ${asset}`);
 const ignores=readFileSync(resolve(root,'.gitignore'),'utf8').split(/\r?\n/);assert.ok(!ignores.includes('dist/'),'GitHub源码必须包含dist');
});
