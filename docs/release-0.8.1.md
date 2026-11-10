# v0.8.1 · Windows 10/11 系统与架构校验

本版本为 Windows 一键安装包增加了明确的系统和 CPU 架构校验，避免不兼容的电脑在解压数百 MB 安装内容后才发现无法运行。

## 安装包

`DSH-Industry-Research-Windows-Setup-v0.8.1-x64.exe`

## 支持范围

| 系统 | 支持情况 | 说明 |
| --- | --- | --- |
| Windows 11 x64 | 支持 | 推荐 |
| Windows 10 x64 | 支持 | 需要 64 位系统 |
| Windows 10 x86（32 位） | 不支持 | 官方 DeepSeek Harness 桌面端只有 x64 构建 |
| Windows 11 ARM64 | 暂不支持 | 尚未验证，请使用 x64 电脑 |
| Windows 8.1、Windows 7 及更早版本 | 不支持 | 安装器会在启动时提示并停止 |
| Windows Server | 不支持 | 本安装包面向 Windows 10/11 桌面版 |

安装器在 NSIS 启动阶段和 PowerShell 安装阶段各校验一次。32 位 Windows、ARM64、旧版 Windows 和 Windows Server 都会在写入插件文件之前停止，并显示当前检测到的版本与架构。

## 为什么暂时没有 x86 安装包

官方 DeepSeek Harness 桌面端当前只发布 `win-x64` 构建；其安装内容只有 `app-64.7z`，主程序也是 x64。行研工作台还依赖 `node-pty` 的 x64 原生终端文件。因此不能仅通过修改外层安装脚本增加 32 位支持，需要上游先提供 32 位 DSH/Electron 构建并补齐 ia32 原生依赖。

## 升级说明

- 行研工作台从 0.8.0 升级到 0.8.1。
- 预装插件版本保持不变。
- 已有 DSH 设置、插件、账号和调研数据会保留。
- 安装包文件名增加 `-x64` 后缀，避免把目标架构误认为通用安装包。

## 校验

Release 同时提供安装包的 `.sha256` 文件和 `windows-bundle.json`，其中记录目标系统、目标架构和官方 DSH 安装器哈希。
