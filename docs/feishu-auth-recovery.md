# 飞书授权自动恢复

工作台把本机 `lark-cli` 的认证故障转换为稳定的恢复动作。用户不需要手动执行 `lark-cli auth status` 或判断 DPoP、token、scope 的区别。

## 自动流程

1. 打开或刷新飞书绑定时，后台运行 `auth status --json --verify`。
2. 将结果分类为应用未配置、用户未授权、token 失效、DPoP 密钥不可用、权限缺失、账号不一致、网络异常或 CLI 安装异常。
3. 对可恢复的用户授权问题自动发起官方扫码流程，直接在工作台展示二维码。
4. 页面开始扫码后，后台使用 `device-code` 等待授权；扫码完成即完成令牌交换，不要求用户再次点击按钮。
5. 页面轮询绑定状态。授权成功后自动关闭绑定窗口，并重新打开原先生成或定时配置表单。

用户唯一必须完成的步骤是在飞书官方页面确认当前账号和所需权限。

## 更换账号与更换应用

- `更换账号`要求最终个人授权使用另一个飞书账号，并选择或创建该账号可管理的应用；个人授权仍是旧账号时会回滚并提示重新扫码。
- `更换应用`进入官方应用登记/选择流程，但最终个人授权必须保持当前账号不变。应用管理页允许由有权限的管理账号登录，该管理身份不用于判断个人授权账号。
- 跨应用账号比较使用 `union_id`，不使用应用内唯一的 `open_id`；旧数据缺少 `union_id` 时会在切换前通过当前个人授权读取。
- 应用登记完成后先保存为待确认状态。只有个人授权完成并通过 `lark-cli auth status` 验证后，才提交新应用与账号；账号条件不符时恢复原绑定。
- 通知失败时点击`修复机器人权限`，只对当前应用发起权限差异确认，不切换个人账号。

## 错误处理

| 自动分类 | 页面动作 |
|---|---|
| `LARK_DPOP_KEY_UNAVAILABLE` | 自动重新扫码授权，重建本机签名密钥 |
| `LARK_USER_AUTH_EXPIRED` | 自动重新扫码授权 |
| `LARK_SCOPE_MISSING` | 自动按工作台所需文档/云盘权限重新授权 |
| `LARK_APP_NOT_CONFIGURED` | 自动进入扫码登录与应用绑定流程 |
| `LARK_ACCOUNT_MISMATCH` | 提示使用同一账号授权，或通过“更换账号”绑定新账号的应用 |
| `LARK_NETWORK_UNAVAILABLE` | 保留二维码，提示检查网络后重试 |
| `LARK_CLI_NOT_FOUND` / `LARK_POWERSHELL_POLICY` | 提示修复本机 CLI；不伪装成授权失败 |

错误响应只返回分类、动作和面向用户的说明，不回传命令输出、token、device code、App Secret 或私钥信息。

## 支持排查

自动恢复仍失败时，依次确认：

```powershell
lark-cli --version
lark-cli auth status --json --verify
```

如果 PowerShell 阻止 `.ps1`，直接使用 npm 生成的 `.cmd` 入口：

```powershell
& "$env:APPDATA\npm\lark-cli.cmd" auth status --json --verify
```

工作台在 Windows 上优先调用 Lark CLI 的原生入口，以避免 shell 参数转义和 PowerShell 脚本执行策略影响授权链接。
