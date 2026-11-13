# DSH 行研工作台 0.8.2

发布日期：2026-11-05

## 安装器规范化

- 安装器和卸载器共用固定 GUID 的命名互斥锁（mutex）。连续双击安装包时，第二个进程只会尝试还原并激活已经打开的安装窗口，然后退出，不会出现多个安装窗口。
- 安装和卸载互斥，避免安装过程中同时卸载、或重复覆盖文件。
- 使用标准“欢迎 → 安装进度 → 完成”向导，并提供标准卸载确认页。
- 安装成功后写入当前用户的 Windows 卸载注册表项，自动出现在“设置 > 应用 > 已安装的应用”。
- 生成标准 `Uninstall.exe`，同时注册 `QuietUninstallString`，支持 `/S` 静默卸载。
- 安装器支持 `/S` 静默安装：静默模式下不显示 MessageBox，不自动启动 DSH；如果 DSH 正在运行则明确失败，不强制结束用户进程。
- PowerShell 安装或卸载失败时，退出码会透传给 NSIS；NSIS 使用 `SetErrorLevel` 返回非零退出码，便于企业软件分发工具判断结果。
- 安装器仍只申请当前用户权限，只写入 `HKCU` 和当前用户目录，不触发 UAC。
- 安装包仍只支持 Windows 10/11 x64。官方 DeepSeek Harness 没有 x86 或 ARM64 构建，不能通过修改安装器增加这些架构支持。

## 修复

- 修复安装器单实例锁成功分支的标签顺序错误。
- 修复 MUI 页面会修改普通寄存器 `$5`，导致卸载注册表键可能指向错误位置的问题；改用独立命名变量。
- 修复卸载脚本自身弹确认框、与 NSIS 卸载确认页重复的问题。
- 静默安装不再回退到图形安装向导。
- 卸载完成页和错误提示均兼容 `/S` 静默模式。

## 安装包

文件：

```text
DSH-Industry-Research-Windows-Setup-v0.8.2-x64.exe
```

大小：`336,849,924` 字节（约 321.2 MB）

SHA256：

```text
7cbc9298b1c27f15bbb95b4d1f21a060c28955d75ef12ac4e16938533ee443f2
```

## 验收

自动验收命令：

```powershell
npm run test:installer
```

真实验收覆盖并通过：

- 第一个安装器显示窗口。
- 第二次启动只退出一个进程，退出码为 `2`，不产生第二个安装窗口。
- `/S` 静默安装返回 `0`，插件文件安装到隔离目录。
- 生成 `Uninstall.exe`。
- 卸载注册表项包含显示名称、版本、安装位置、卸载命令、静默卸载命令，以及 `NoModify=1`、`NoRepair=1`。
- `/S` 静默卸载返回 `0`，卸载项和受管插件目录被清理。

自动化结果保存在 `artifacts/installer-acceptance.json`。

## 参考规范

- NSIS 单实例安装器：<https://nsis.sourceforge.io/Allow_only_one_installer_instance>
- Microsoft 卸载注册表项：<https://learn.microsoft.com/en-us/windows/win32/msi/uninstall-registry-key>
- NSIS 静默安装示例：`C:\Program Files (x86)\NSIS\Examples\silent.nsi`
- NSIS 当前用户安装示例：`C:\Program Files (x86)\NSIS\Examples\install-per-user.nsi`
