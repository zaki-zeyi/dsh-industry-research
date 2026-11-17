# 拿锁后模型直接报错的补充验收

2026-11-17，北京时间约 16:16–16:21。使用已经安装过的 `artifacts/dsh-industry-research-0.13.2-dev.3` 包，在隔离的真实 DSH Profile 中验证；未调整桌面 Profile、真实 Key 或账户额度。

## 注入位置

本次不由 Agent 写 `failed` 回执，也不由测试脚本直接发送宿主 `turn/end`。

本机模型接口先返回原生 `pwsh` 工具调用，由真实 DSH Agent 循环执行保存锁命令。确认许可文件已经生成、交付文件不存在后，下一次模型请求直接返回错误：

| 场景 | 模型接口故障 | 真实宿主记录 |
| --- | --- | --- |
| Key 失效／认证失败 | HTTP 401，`invalid_api_key` | `turn/end: error`，`AUTH` |
| 额度不足 | HTTP 402，`insufficient_balance` | `turn/end: error`，`QUOTA` |
| 网络异常 | 请求连接直接断开 | `turn/end: error`，`TRANSPORT` |

隔离 Profile 的模型自动重试次数设为 0，以直接验证异常终止后的释放与手动重试；不改变用户模型的重试配置。模型是本机受控接口，不向真实模型服务商提交错误凭据或消耗额度制造故障。

## 每类错误的断言

1. 错误之前已由原生工具取得保存锁。
2. Agent 没有写任何失败交付文件；平台从宿主错误事件自动识别失败。
3. 旧许可请求启动写操作返回 409。
4. 一个独立任务可以实际取得同一资料库的锁，证明锁已释放，而非只改失败标签。该独立任务也在取得锁后遭遇同类模型故障，因此每类记录包含两次失败模型请求。
5. 在实际插件页面点击原任务的「重试」；原 DSH 会话保留，执行绑定和保存许可更新。
6. 重试后的原生工具通过受保护的 CLI 启动器，读取、修改并读回公司文档和索引；之后才写成功交付回执。
7. 后端恢复 `ready / published`；详情自动显示已完成，返回历史列表后同一张卡片显示已完成，重试按钮消失。

## 真实飞书结果

先通过持久化测试存储运行三类场景，再使用现有已授权的飞书 CLI Profile 复跑。真实读写没有注册新授权或复制凭据；目录测试适配器使用现有工作台已确认的根目录、全量库和索引定位，文档与认证调用交给真实 CLI。

只更新后摩智能既有来源标注的核验时间和该公司的索引时间；不增加测试章节，不制造新动态。

| 场景 | 公司文档版本 | 公司索引版本 | 结果 |
| --- | --- | --- | --- |
| Key 失效 | 11 → 12 | 19 → 20 | 通过 |
| 额度不足 | 12 → 13 | 20 → 21 | 通过 |
| 网络断连 | 13 → 14 | 21 → 22 | 通过 |

三轮读回均确认索引仍有 8 家公司、原文档链接保留，其余公司的索引记录逐字段不变。

这证明模型接口直接报错、Agent 无法回传失败时的恢复路径；不是只复测 Agent 主动回传失败。故障本身仍是模型传输层的受控注入，不是人为使真实账户失效。

## 复跑与证据

测试存储：

```powershell
npm run test:model-failures -- --package-root artifacts/dsh-industry-research-0.13.2-dev.3
```

真实飞书（会修改既有核验时间；运行前要求当前工作台没有调研任务执行）：

```powershell
npm run test:model-failures -- --package-root artifacts/dsh-industry-research-0.13.2-dev.3 --live-feishu
```

真实飞书模式使用此前实机验收的 `lock-live-dev3-evidence.json` 定位现有任务和 CLI Profile；只读其身份引用及目录元数据，不读取模型 Key。

- `artifacts/diagnostics/model-failure-host-fixture.json`：测试存储结果。
- `artifacts/diagnostics/model-failure-host-live.json`：真实飞书版本变化与宿主错误码。
- `scripts/model-failure-host-acceptance.mjs`：真实宿主、模型故障及页面断言。
- `scripts/fixtures/model-failure-agent-step.mjs`：由原生工具执行的拿锁、写入、读回及交付步骤。

本次只增加验收代码与记录，未发现需要进一步修改已安装保存锁实现的问题。
