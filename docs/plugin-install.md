# 安装与发布

插件包名 `dsh-industry-research`，页签「行研工作台」。当前源码版本 0.8.14。

## 用户安装

Windows/macOS 桌面版和网页版的「添加插件」均可填写：

```text
https://github.com/zaki-zeyi/dsh-industry-research.git#release
```

仓库默认分支为 `main`，保存开发源码；安装地址通过 `#release` 显式选择保存预构建页面和完整生产依赖的 `release` 分支。网页端的下载、安装、执行均在 DSH 服务端发生。

本地目录安装：从 GitHub Releases 下载所需版本的 `desktop.zip`，解压后在弹窗填写包含 `package.json` 的目录绝对路径。网页版填写服务所在机器上的路径。保留目录，按宿主提示启用或重新加载。ZIP 包含 Windows/macOS x64、arm64 的原生终端依赖。

也可使用宿主 CLI：

```sh
dsh plugin --profile <profile> add https://github.com/zaki-zeyi/dsh-industry-research.git#release
dsh plugin --profile <profile> add <tgz绝对路径>
```

先核对安装页面显示的版本，再启用插件。下载 ZIP/TGZ 后可使用同名 `.sha256` 校验文件。Windows 示例：`Get-FileHash <文件> -Algorithm SHA256`。

宿主需要模型、检索工具及 Lark CLI。桌面版在本机安装 CLI，网页版在服务器安装；首次使用扫码绑定飞书。原始资料在网页版使用网络链接；本地原始文件选择需要桌面路径桥接。安装包不包含凭据、数据库或真实报告。

默认数据目录 `~/.dsh/industry-research`。升级保留数据，插件本身不依赖精选第三方插件。

0.8.14 的标准产物为插件 ZIP/TGZ。历史 Windows 一体化 EXE 会安装官方 DSH 和精选插件，是独立发布产物，不代表最新插件版本；不以历史 EXE 代替当前版本验证。

## 维护者发布

在 main 更新 package.json/package-lock.json 的同一版本后，合入 main 自动触发 **Publish verified plugin**。失败后可在已有Actions运行中重试。release分支只包含可安装产物，发布工作流保存在main，不要求发布凭据具有修改默认分支工作流的权限。流程：

1. Windows 和 macOS 分别运行构建、业务测试、浏览器测试。
2. 打包 ZIP/TGZ，校验独立安装、页面、生产依赖和原生 PTY。
3. 从通过验证的 Windows ZIP 恢复原目录，校验版本、源码提交和 SHA256。
4. 将安装目录同步到 release 分支，使用普通 push 保留历史，不强制覆盖。
5. 冷缓存安装显式带 #release 的公开 GitHub 链接，断言安装版本等于源码版本并运行安装包验收。
6. 创建与源码提交绑定的版本标签和 GitHub Release，上传版本包、校验文件及来源清单。

已有同名正式版本时停止，必须先增加版本号。CI 失败不能当作成功发布；release 分支已同步但 Release 创建失败时，检查日志，修复后补齐同一版本资产。仓库默认分支可以保持 main；安装与冷缓存验收均显式指定 #release，避免安装开发源码。

本地复现：

```sh
npm ci --ignore-scripts
npm run acceptance
npm run plugin:pack
npm run plugin:check-pack
node scripts/release-acceptance.mjs
node scripts/git-install-acceptance.mjs --pnpm-cli <宿主pnpm入口> --expected-version 0.8.14
```

macOS CI 运行包安装及浏览器验收，不等同于真实 macOS 桌面应用点击验收。真实飞书授权、模型调研、音视频转写和机器人消息需要实际环境单独验收。

## 官方定时服务前置条件

定时日报/周报借用宿主的官方 Schedule 服务。DSH 0.2.0-rc.2 默认 Web composition 未加载此服务；需由宿主安装并启用官方 `@deepseek-ai/dsh-experimental-schedule-bundle`（或等价官方Schedule配置）。例如：`dsh plugin --profile <profile> add @deepseek-ai/dsh-experimental-schedule-bundle`。行研插件不注册或占有共享schedule组件。缺少服务时明确返回503；手动调研、报告与飞书连接仍可使用。隔离真实宿主验收显式加载官方Schedule，与生产插件包所有权分离。
