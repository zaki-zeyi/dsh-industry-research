import assert from 'node:assert/strict';

export function installationManifest(source) {
  assert.ok(!Object.hasOwn(source, 'bundledDependencies') && !Object.hasOwn(source, 'bundleDependencies'),
    '源码清单不得声明内置依赖，否则直接 Git 安装会跳过依赖安装');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish']) {
    assert.ok(!source.scripts?.[hook], `发布包不得带生命周期脚本：${hook}`);
  }
  return { ...source, bundledDependencies: Object.keys(source.dependencies) };
}
