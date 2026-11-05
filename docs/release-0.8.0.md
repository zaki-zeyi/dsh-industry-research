# v0.8.0 · Windows 一键安装包预装精选插件

本版本在 Windows 一键安装包中加入 3 个固定版本、经过 SHA256 校验的 DSH bundle 插件，安装官方 DeepSeek Harness 后即可直接使用。

## 预装插件

| 插件 | 版本 | 项目 |
| --- | --- | --- |
| `dsh-brand` | 0.2.0-rc.6 | https://github.com/advance-lion/dsh-brand |
| `dshmarket` | 1.73.11 | https://github.com/dsh-market/dsh-market |
| `@xmanrui/dsh-im` | 5.10.0 | https://github.com/xmanrui/dsh-im |

安装器会把插件文件放在 `%LOCALAPPDATA%\DSH Industry Research\bundled-plugins`，通过 junction 接入 DSH 桌面 profile，并把包名加入 `bundles`。已有同名插件会保留用户当前来源和配置。

## 关于悬浮球

`mini-yifan/deepseek-harness-orb` 不是 DSH 插件，而是基于 DeepSeek Harness 的独立 Electron 桌面应用 DeepSeek Orb。它不能像插件一样挂载到官方 DSH profile，因此本次没有把它作为第 4 个插件写入安装包。

## 升级说明

- 行研工作台从 0.7.3 升级到 0.8.0。
- 预装插件不覆盖用户已有同名插件。
- 卸载只移除本安装包实际管理的行研工作台和精选插件。
- 用户调研数据、账号、Token 和飞书凭据不会被打入安装包，也不会在升级时删除。

## 校验

Release 同时提供 Windows 安装包的 `.sha256` 文件和 `windows-bundle.json`。插件源包及哈希固定在 `installer/windows/bundled-plugins.json`，构建时会重新校验。
