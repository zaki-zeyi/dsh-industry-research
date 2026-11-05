DSH 行研工作台 Windows 一键安装包
=================================

版本：行研工作台 {{PLUGIN_VERSION}} / DeepSeek Harness {{DESKTOP_VERSION}}

一、安装
--------
1. 双击 DSH-Industry-Research-Windows-Setup-v{{PLUGIN_VERSION}}.exe。
2. 如果电脑还没有 DeepSeek Harness，安装器会先安装官方桌面端。
3. 安装器会自动把行研工作台装进 DSH，并启动桌面端。
4. 打开 DSH 后，在侧栏点击“行研工作台”，按页面提示绑定飞书。

不需要安装 Node.js、npm，也不需要手动添加插件。

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

调研数据仍保存在 DSH 的用户目录中：

    %USERPROFILE%\.dsh\industry-research

安装包不会包含或上传任何本机账号、Token、飞书凭据、数据库或历史任务。

四、卸载
--------
打开下面的目录，双击“Uninstall.cmd”：

    %LOCALAPPDATA%\DSH Industry Research

卸载只会从 DSH 配置中移除行研工作台，不会删除已有调研数据。DeepSeek Harness 本身请在 Windows“设置 > 应用”中卸载。

五、排错
--------
安装日志：

    %TEMP%\dsh-industry-research-bundle.log

常见问题：
1. 安装后侧栏没有“行研工作台”：完全退出 DSH 后重新打开。
2. 提示插件端口被占用：关闭旧的调研服务或重启 DSH。
3. 飞书无法绑定：检查网络、飞书应用权限和账号权限，按工作台提示重试。

六、说明
--------
本安装包内含未经修改的 DeepSeek Harness 官方安装器。DeepSeek Harness 的名称、品牌和程序归其权利人所有；安装时请遵守官方许可和使用条款。第三方组件说明见 THIRD-PARTY-NOTICES.txt。
