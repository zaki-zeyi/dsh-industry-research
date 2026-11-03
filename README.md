# dsh-industry-research · 行研工作台

基于飞书《行研平台prd轻量化》修订版 449 实现的 DeepSeek Harness 插件。复用本机既有调研工作台的宿主适配与授权代码，在独立命名空间内提供公司全量信息库与友商分析。

- 默认 17 家公司、5 个维度、16 个信源，支持全网查询与自定义；新增维度和信源持久保存。
- 编辑任务 Prompt，绑定飞书后启动 DSH 标准模式原生会话；所有任务共享插件工作区。
- 飞书根目录下建立「全量信息库」，一家公司一份文档。向 Agent 提供已有文档链接，要求先读后增量更新、去重，逐条引用来源和日期，保留并标注冲突。
- 单次调研超过 30 分钟仍未完成则失败，保留已完成文档和会话记录。
- 公司文档卡片与历史 AI 任务分开展示，支持搜索、继续对话、失败重试；部分完成时保留已交付公司。
- 已知「公司索引」飞书文档支持刷新公司清单，不要求枚举云盘目录。SQLite 只镜像文档链接、维度和交付统计等元信息。
- 独立「友商分析」页签支持选择至少两家已收录公司和对比维度，默认 Prompt 可编辑；报告严格只引用全量信息库，资料不足时明确标注。
- 友商报告保存在飞书根目录的「友商分析」子目录，通过「分析报告索引」刷新历史卡片；每张卡片可打开报告或回到对应 AI 会话。

## 本地开发

需要 Node.js ≥22.13。

```bash
npm ci
npm run dev
```

开发界面访问终端显示的 Vite 地址。默认运行离线流程演示，不检索真实资料或写入飞书；演示任务只验证表单和任务流。真实调研必须在 DSH 插件宿主中执行，使用宿主已配置的模型和工具。

```bash
npm run acceptance
npm run test:native-host
npm run plugin:pack
```

`acceptance` 包含构建、业务/API 回归与浏览器验收。`test:native-host` 启动隔离的真实 DSH 宿主，模型和飞书交付使用本机测试夹具，不调用外部模型或修改真实飞书文档。

## 安装

运行 `npm run plugin:pack` 后生成：

- `artifacts/dsh-industry-research-0.2.0-desktop.zip`
- `artifacts/dsh-industry-research-0.2.0.tgz`
- `artifacts/dsh-industry-research-0.2.0/` 可直接安装目录

在 DSH 桌面版「添加插件」中填写上述解压目录的绝对路径，按宿主提示启用或重新加载。Windows 和 macOS 使用同一个 ZIP；网页版可以使用 DSH CLI 安装 tgz。详见 [安装说明](docs/plugin-install.md)。

公开仓库：[zaki-zeyi/dsh-industry-research](https://github.com/zaki-zeyi/dsh-industry-research)。

在 DSH「添加插件」中填写仓库地址即可安装。默认 `release` 分支包含预构建页面和完整生产依赖，无需执行安装脚本；开发源码位于 `main` 分支。

```text
https://github.com/zaki-zeyi/dsh-industry-research
```

## 验证边界

自动测试验证配置持久化、宿主会话、交付回执、公司/友商报告索引、错误恢复与界面交互。真实扫码授权、企业审批、付费信源可访问性和实际调研内容质量需要真实环境验收。Agent 声称完成时须交付公司或友商报告的真实飞书链接；平台校验回执结构、来源范围及链接稳定性，不逐条审计远端事实。增量去重、图表和文档内高亮由 Agent 执行。

[PRD 快照](docs/prd-lightweight-449.md) · [架构](docs/architecture.md) · [验收记录](docs/acceptance-report.md)
