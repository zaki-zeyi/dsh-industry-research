# 安装与运行

插件包名 `dsh-industry-research`，页签名「行研工作台」。

1. `npm ci` 安装依赖，`npm run acceptance` 验收，`npm run plugin:pack` 打包。
2. 解压 `artifacts/dsh-industry-research-0.7.1-desktop.zip`，在 DSH「添加插件」填写解压后包含 package.json 的目录。安装后保留该目录。
3. 安装并启用，按宿主提示重新加载。macOS / Windows 支持 x64、arm64；Windows 建议使用较短路径。
4. 网页版通过 `dsh plugin --profile <你的profile> add <tgz绝对路径>` 安装；使用配置好的 DSH 网页宿主运行。
5. 宿主需有模型和检索工具；其运行环境需安装 Lark CLI。
6. 点击「绑定飞书」，完成目标账号、应用及个人文档授权；切换账号需要重新绑定匹配应用。日报/周报机器人通知还要求应用具备 `im:message:send_as_bot`，且绑定用户处于机器人可用范围内。
7. 可设置根目录名字（默认「行研工作台」）或已有飞书文件夹链接。不会读取目录列表。
8. 点击「更新全量信息库」，配置公司、维度、信源，启动原生 AI 会话。完成后卡片跳转公司飞书文档。
9. 点击「友商分析」，选择至少两家已收录公司和对比维度，按需修改默认 Prompt 后启动。报告保存在「友商分析」子目录；卡片可打开报告或回到对应 AI 会话，资料不足会明确标注。

默认数据目录 `~/.dsh/industry-research`，可通过插件 dataDir 覆盖。它与原 `dsh-research-workbench` 数据隔离，升级不会删除原插件的任务或凭据。会话使用标准模式和宿主完整访问预设。二维码与授权由用户本人完成。

真实飞书/检索验收尚需用户登录与可用模型；安装包不含凭据、业务数据库或真实报告。

公开仓库：https://github.com/zaki-zeyi/dsh-industry-research 。在 DSH 添加插件时直接填写该地址；默认 release 分支是自包含安装版，main 分支保存开发源码。版本化 ZIP/tgz 与校验文件见 GitHub Releases。
