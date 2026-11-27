# 安装与发布

插件包名 `dsh-industry-research`，页签「行研工作台」。正式版本以 [GitHub Releases](https://github.com/zaki-zeyi/dsh-industry-research/releases) 为准。

## 用户安装

推荐通过下方的 [DSH「插件 → 发现」](#从-dsh-插件页面安装与更新) 安装。它使用经过验证的固定 Git 提交，后续可从 DSH 原地更新。手动添加时，可用 `https://github.com/zaki-zeyi/dsh-industry-research.git#<安装提交>`，提交取自 [官方索引](../dsh-plugin-index.json) 的 `source.commit`。从 0.13.28 起，填写不带后缀的仓库地址也能安装，宿主会从 npm 源解析运行依赖。网页端的下载、安装和执行均在 DSH 服务端发生。

本地目录安装：从 GitHub Releases 下载所需版本的 `desktop.zip`，解压后在弹窗填写包含 `package.json` 的目录绝对路径。网页版填写服务所在机器上的路径。保留目录，按宿主提示启用或重新加载。ZIP 包含 Windows/macOS x64、arm64 的原生终端依赖。

也可使用宿主 CLI：

```sh
dsh plugin --profile <profile> add 'https://github.com/zaki-zeyi/dsh-industry-research.git#<安装提交>'
dsh plugin --profile <profile> add <tgz绝对路径>
```

先核对安装页面显示的版本，再启用插件。下载 ZIP/TGZ 后可使用同名 `.sha256` 校验文件。Windows 示例：`Get-FileHash <文件> -Algorithm SHA256`。

宿主需要模型、检索工具及 Lark CLI。桌面版在本机安装 CLI，网页版在服务器安装；首次使用扫码绑定飞书。原始资料在网页版使用网络链接；本地原始文件选择需要桌面路径桥接。安装包不包含凭据、数据库或真实报告。

默认数据目录 `~/.dsh/industry-research`。升级保留数据，插件本身不依赖精选第三方插件。

0.8.14 的标准产物为插件 ZIP/TGZ。历史 Windows 一体化 EXE 会安装官方 DSH 和精选插件，是独立发布产物，不代表最新插件版本；不以历史 EXE 代替当前版本验证。

## 从 DSH 插件页面安装与更新

使用支持固定 Git 提交更新的 DSH（0.2.2-rc.2 起；网页版由服务器上的 DSH 版本决定）：

1. 打开 DSH「插件」，在实验插件列表中启用「自定义插件索引」；如果首页未显示，打开「更多」。
2. 在「发现」添加以下索引地址：

   ```text
   https://raw.githubusercontent.com/zaki-zeyi/dsh-industry-research/main/dsh-plugin-index.json
   ```

3. 在索引中打开「行研工作台」。未安装时点击「安装」；已从该仓库的固定提交安装且有更新时，点击「更新」并确认。DSH 会显示安装结果以及新版是已运行还是需要重启；如果失败，请以 DSH 显示的实际状态为准。更新前请让在途调研与保存先完成。

使用 `#release`、安装标签或 ZIP/TGZ 等非固定 Git 提交来源安装的版本，DSH 不会提供原地更新。让在途任务完成后，在「已安装」卸载旧插件，再从上述索引安装一次，并恢复原来的启用状态。不要删除工作台数据目录；如设置了自定义数据目录，继续使用原路径（默认 `~/.dsh/industry-research`）。若当前业务版本比宿主显示版本新，宿主仍按其管理的安装版本判断是否显示「更新」。行研工作台内部的更新设置独立于此入口。

从 0.13.25 起，同一预构建 Git 安装包和 ZIP 解压目录可在 Linux 的 DSH 网页版启用行研工作台；调研使用宿主原生会话，不需要安装或编译插件的旧版 PTY。Windows/macOS 的原生终端依赖保留。正式包仍不内置 Linux 的旧版交互终端；旧终端任务可查看已有记录，但需要原 PTY 的继续执行、重试或上传不受支持。如果仍依赖这些旧任务，请保留已可用的 Linux 自行构建版本。

## 官方详情页更新按钮

固定 Git 提交安装后，在「插件 → 行研工作台」详情页直接检查更新并点击「更新到…」。按钮由行研工作台通过官方详情页扩展位提供，连接我们的更新服务，再调用 DSH 官方 Git 更新流程。工作台内的离线包更新和空闲时更新继续保留，两入口不能同时安装。具体在线、离线和生效范围见 [官方 Git 更新机制](official-git-update.md)。

## 维护者发布

在 main 更新 package.json/package-lock.json 的同一版本后，合入 main 自动触发 **Publish verified plugin**。失败后可在已有Actions运行中重试。发布分支是源码镜像加验证产物，推送使用工作流内置凭据，不需要额外的仓库设置；安装内容仍由安装清单的 `files` 决定。流程：

1. Windows 和 macOS 分别运行构建、业务测试、浏览器测试，并使用 DSH 同版本 pnpm 从本次源码提交冷安装，验证所有运行依赖可解析且工作台可启动。
2. 打包 ZIP/TGZ，校验独立安装、页面、生产依赖和 Windows/macOS 原生 PTY。Linux 网页端单独复验同样不含 Linux PTY 的安装包，确认 TGZ/ZIP 能启动，解压目录可由 DSH 宿主安装并在浏览器运行原生会话。
3. 从通过验证的 Windows ZIP 恢复原目录，校验版本、源码提交和 SHA256。
4. 把安装目录写成 release 分支的发布提交：父提交同时指向上一发布提交和产出该产物的源码提交，内容为源码目录叠加验证产物，使用普通 push 保留历史，不强制覆盖。
5. 冷缓存安装显式带 #release 的公开 GitHub 链接，断言安装版本等于源码版本并运行安装包验收。
6. 创建与源码提交绑定的版本标签和 GitHub Release，上传版本包、校验文件及来源清单。
7. 正式 Release 发布后，CI 自动运行 `publish-dsh-plugin-index.mjs`，校验不可变发布并更新主分支的官方插件索引；遇到并发修改会重读并重试，不覆盖更高版本。需要手工补发时，用 `node scripts/write-dsh-plugin-index.mjs`（需要已登录的 `gh`）生成索引，提交 `dsh-plugin-index.json` 并合入 `main`。脚本校验发布清单摘要及安装标签指向的固定提交；失败时不会覆盖索引。DSH「发现」只会在索引合入后看到新版，不会直接追踪 `release` 分支。

已有同名正式版本时停止，必须先增加版本号。release 分支已同步但 Release 创建失败时，检查日志，修复后补齐同一版本资产。仓库默认分支为 `main`，固定提交安装入口使用发布分支的预构建提交。

`release` 与 `main` 共享历史。两种安装方式共用源码清单里的版本号和依赖列表。构建正式包时才添加 `bundledDependencies`，对应的全部生产依赖一并内置。发布校验会检查这项生成字段及其余清单内容，因此源码 Git 安装仍会解析依赖，正式安装包仍可离线安装。前端构建依赖列入 `devDependencies`，`files` 限制实际打包内容。

需要时可在 `release` 分支 `git merge main`，版本号、依赖与其他源码修改一样正常合并，无需 `git checkout --ours package.json`、自定义 merge driver 或本机 Git 配置。注意：手工合并仅同步源码和清单，不会重新生成 `dist` 和内置依赖，不能代替构建、验收和正式发布；不要把这种未发布的中间状态当成新版本安装包。反向把 `release` 合并进 `main` 只会把构建产物和生产依赖带进开发分支。

安装分支不镜像 `.github`：工作流的创建和修改需要 `workflow` 权限，发布工作流内置的 `GITHUB_TOKEN` 没有该权限（实测该凭据能推送普通提交、推送工作流文件被拒），把 `.github` 纳入安装分支会让发布推送失败。手工合并 `main` 时，`main` 改过的工作流报「deleted by us」冲突，`main` 新增的工作流会被直接带回；两种情况都在提交前执行 `git rm -r .github` 再推送，下一次发布也不会带回 `.github`。发布分支不再触发源码验收工作流（`acceptance.yml` 已忽略 `release`）。

本地复现：

```sh
npm ci --ignore-scripts
npm run acceptance
npm run plugin:pack
npm run plugin:check-pack
node scripts/release-acceptance.mjs
node scripts/publish-git-plugin.mjs --output <新的临时目录>   # 不加 --push 时只在本地生成安装提交
node scripts/git-install-acceptance.mjs --pnpm-cli <宿主pnpm入口> --expected-version <正式版本>
```

Linux 复验须使用未内置 Linux `pty.node` 的 ZIP/TGZ（例如 Windows CI 产物）；安装 Playwright Chromium 后，设 `DSH_CLI_PATH` 为 DSH 的 `lib/bin.js` 绝对路径，再运行 `node scripts/release-acceptance.mjs --without-legacy-pty --native-host`。如需冷缓存验证已发布的 Git 安装包，可为 Git 验收命令加 `--without-legacy-pty --source <固定提交安装地址>`。

macOS CI 运行包安装及浏览器验收，不等同于真实 macOS 桌面应用点击验收。真实飞书授权、模型调研、音视频转写和机器人消息需要实际环境单独验收。

## 官方定时服务前置条件

定时日报/周报借用宿主的官方 Schedule 服务。DSH 0.2.0-rc.2 默认 Web composition 未加载此服务；需由宿主安装并启用官方 `@deepseek-ai/dsh-experimental-schedule-bundle`（或等价官方Schedule配置）。例如：`dsh plugin --profile <profile> add @deepseek-ai/dsh-experimental-schedule-bundle`。行研插件不注册或占有共享schedule组件。缺少服务时明确返回503；手动调研、报告与飞书连接仍可使用。隔离真实宿主验收显式加载官方Schedule，与生产插件包所有权分离。
