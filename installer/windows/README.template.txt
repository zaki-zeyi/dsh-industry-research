DSH 行研工作台 Windows 一键安装包
=================================

版本：行研工作台 {{PLUGIN_VERSION}} / DeepSeek Harness {{DESKTOP_VERSION}}
目标系统：{{TARGET_OS}}（{{TARGET_ARCH}}）

系统要求
--------
* Windows 10 64 位或 Windows 11 64 位。
* 64 位 x64 处理器与操作系统。
* 32 位 Windows 10 无法运行官方 DeepSeek Harness 桌面端，因此本安装包会阻止安装并给出提示。
* Windows 11 ARM64 暂未验证；请使用 x64 电脑。

一、安装
--------
1. 双击 {{INSTALLER_FILENAME}}。
2. 如果电脑还没有 DeepSeek Harness，安装器会先安装官方桌面端。
3. 安装器会自动把行研工作台和精选插件装进 DSH，并启动桌面端。
4. 打开 DSH 后，在侧栏点击“行研工作台”，按页面提示绑定飞书。

不需要安装 Node.js、npm，也不需要手动添加插件。

重复双击安装包不会打开多个安装窗口，系统会切回已经打开的安装程序。安装和卸载不能同时进行。

预装的精选插件
--------------

本安装包同时预装以下 DSH 插件：

* 行研工作台（dsh-industry-research）
* 商标 Branding（dsh-brand）
* 插件市场（dshmarket）
* IM 机器人（@xmanrui/dsh-im，支持飞书、微信、企业微信、钉钉、QQ、Slack、Telegram、Discord 等）
* 悬浮球（dsh-orb 0.2.0，来自 mini-yifan/dsh-orb-cordis）

如果电脑上已经安装过同名插件，安装器会保留用户已有的插件来源和配置，不覆盖它们。

进入方式：

* 商标：DSH 设置 → 品牌 Branding
* 插件市场：DSH 设置 → 插件 → 插件市场
* IM 机器人：DSH 设置 → IM机器人

预装的 dsh-orb 是可挂载到官方 DSH 的独立 bundle 插件，与早期独立桌面应用 DeepSeek Orb 不同。行研工作台本身不依赖它；已有同名插件时保留用户当前来源和配置。

如果 Windows 提示“Windows 已保护你的电脑”，请点击“更多信息”，再点击“仍要运行”。这是因为本安装包尚未使用 Windows 代码签名证书；内部发放时属于正常提示。

如果电脑由公司统一管理，可能出现“应用程序控制策略已阻止此文件”，且没有“仍要运行”按钮。这表示电脑启用了代码完整性或应用控制策略，只允许受信任签名的程序运行。请联系 IT 管理员，使用公司认可的代码签名证书为安装包签名，或申请将该安装包加入允许列表。此类限制不能通过 SmartScreen 的“仍要运行”绕过。

二、已有 DSH 用户
-----------------
安装器会保留原有 DSH 设置、插件、账号和调研数据，只追加行研工作台。安装前会备份 DSH 的桌面配置：

    %USERPROFILE%\.dsh\profiles\desktop\package.json

如果 DSH 正在运行，安装器会提示先关闭它。

三、数据位置
------------
插件代码：

    %LOCALAPPDATA%\DSH Industry Research\plugin\{{PLUGIN_VERSION}}
    %LOCALAPPDATA%\DSH Industry Research\bundled-plugins\

调研数据仍保存在 DSH 的用户目录中：

    %USERPROFILE%\.dsh\industry-research

安装包不会包含或上传任何本机账号、Token、飞书凭据、数据库或历史任务。

四、卸载
--------
打开 Windows“设置 > 应用 > 已安装的应用”，找到“DSH 行研工作台”，点击“卸载”。

如果需要在没有“设置”入口的环境卸载，也可以打开下面的目录，双击“Uninstall.cmd”：

    %LOCALAPPDATA%\DSH Industry Research

卸载只会从 DSH 配置中移除本安装包添加的行研工作台和精选插件，不会删除已有调研、账号和插件数据。DeepSeek Harness 本身请在 Windows“设置 > 应用”中单独卸载。

IT 管理员可以运行下面的命令静默卸载：

    "%LOCALAPPDATA%\DSH Industry Research\Uninstall.exe" /S

五、排错
--------
安装日志：

    %TEMP%\dsh-industry-research-bundle.log

常见问题：
1. 安装后侧栏没有“行研工作台”：完全退出 DSH 后重新打开。
2. 提示插件端口被占用：关闭旧的调研服务或重启 DSH。
3. 飞书无法绑定：检查网络、飞书应用权限和账号权限，按工作台提示重试。
4. 提示系统版本或 32 位系统不支持：请换用 64 位 Windows 10/11。官方 DSH 桌面端没有 32 位构建，无法通过修改安装脚本绕过。

六、说明
--------
本安装包内含未经修改的 DeepSeek Harness 官方安装器。DeepSeek Harness 的名称、品牌和程序归其权利人所有；安装时请遵守官方许可和使用条款。第三方组件说明见 THIRD-PARTY-NOTICES.txt。
