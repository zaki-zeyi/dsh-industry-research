# 安装与运行

插件包名 `dsh-industry-research`，页签名「行研工作台」。

1. Windows 10/11 x64 用户优先运行 `DSH-Industry-Research-Windows-Setup-v0.8.1-x64.exe`；安装器会安装官方 DSH（如未安装）并预装行研工作台和精选插件。32 位 Windows 10 无法运行官方 64 位 DSH，安装器会在解压前阻止安装。
2. 维护者流程：`npm ci` 安装依赖，`npm run acceptance` 验收，`npm run plugin:pack` 打包，再运行 `npm run bundle:plugins` 准备精选插件，最后运行 `npm run bundle:windows` 生成 Windows 一键安装包。
3. ZIP 用户解压 `artifacts/dsh-industry-research-0.8.10-desktop.zip`，在 DSH「添加插件」填写解压后包含 package.json 的目录。安装后保留该目录。0.8.10 提供 ZIP/TGZ，不包含新版 Windows 一体化 EXE。
4. 安装并启用，按宿主提示重新加载。插件 ZIP 支持 macOS 与 Windows 的 x64、arm64；Windows 一体化安装包目前只提供 x64。Windows 建议使用较短路径。
5. 网页版通过 `dsh plugin --profile <你的profile> add <tgz绝对路径>` 安装；使用配置好的 DSH 网页宿主运行。
6. 宿主需有模型和检索工具；其运行环境需安装 Lark CLI。未安装时，在「平台日志 → 飞书连接监测 → 飞书 CLI 环境」查看官方安装命令和 Node.js 下载入口。桌面版在运行 DSH 的电脑安装，网页版在服务所在机器安装；安装后点击「重新检测 CLI」。插件不会静默安装、覆盖已有 CLI 或清除凭据。
7. 点击「绑定飞书」，完成目标账号、应用及个人文档授权；切换账号需要重新绑定匹配应用。日报/周报机器人通知还要求应用具备 `im:message:send_as_bot`，且绑定用户处于机器人可用范围内。
8. 可设置根目录名字（默认「行研工作台」）或已有飞书文件夹链接。首次发现未知根目录或业务子目录时，需要目录读取权限以确认同名目录是否已存在；权限不足时停止创建，不将读取失败视为空目录。已确认的目录 ID 可直接复用。从目录导入和同步历史文档也需要相应读取权限，失败会保留本地记录。内部资料页可在存储位置旁设置目录，新任务使用新目录，历史任务保留原链接。
9. 点击「更新全量信息库」，配置公司、维度、信源，启动原生 AI 会话。完成后卡片跳转公司飞书文档。
10. 点击「友商分析」，选择至少两家已收录公司和对比维度，按需修改默认 Prompt 后启动。报告保存在「友商分析」子目录；卡片可打开报告或回到对应 AI 会话，资料不足会明确标注。

## Windows 一键安装包预装内容

一键安装包除行研工作台外，还会预装并启用以下 DSH bundle 插件：

| 插件 | 版本 | 入口 |
| --- | --- | --- |
| 商标 Branding `dsh-brand` | 0.2.0-rc.6 | 设置 → 品牌 Branding |
| 插件市场 `dshmarket` | 1.73.11 | 设置 → 插件市场（DSH 0.2.0）或插件页 → 插件市场（DSH 0.2.1+） |
| IM 机器人 `@xmanrui/dsh-im` | 5.10.0 | 侧边栏「IM机器人」或设置 → IM机器人 |

如果电脑上已经有同名插件，安装器会保留用户已有依赖和配置；只有本安装包实际新增的插件会记录在 `%LOCALAPPDATA%\DSH Industry Research\installed-plugins.json`，卸载时也只移除这些插件。

悬浮球项目 `deepseek-harness-orb` 是独立的 DeepSeek Orb 桌面应用，不是 DSH 插件，不能加入 DSH profile 的 bundle 列表，也不会被本安装包的插件预装流程安装。

默认数据目录 `~/.dsh/industry-research`，可通过插件 dataDir 覆盖。它与原 `dsh-research-workbench` 数据隔离，升级不会删除原插件的任务或凭据。会话使用标准模式和宿主完整访问预设。二维码与授权由用户本人完成。

真实飞书/检索验收尚需用户登录与可用模型；安装包不含凭据、业务数据库或真实报告。

公开仓库：https://github.com/zaki-zeyi/dsh-industry-research 。在 DSH 添加插件时直接填写该地址；默认 release 分支是自包含安装版，main 分支保存开发源码。版本化 ZIP/tgz 与校验文件见 GitHub Releases。
