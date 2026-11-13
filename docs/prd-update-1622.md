# PRD1622 实现

- 全量信息库页面内提供公司档案/历史AI任务页签，移除侧栏历史下级入口。页签具有tablist/tab/tabpanel语义，支持左右方向、Home/End键，保留搜索、状态和续聊。
- 复用官方桌面接口window.__DSH_HOST_PATHS__.pathFor(file)。该接口已从官方源码packages/client/ui-conversation/src/client/apply.ts及已安装桌面版app.asar中的ui-conversation/lib/client.js、lib/preload-app.cjs确认。
- 文件选择器在DSH宿主文档打开，文件File对象仅在宿主本地交给官方pathFor；只把path和size元信息回传工作台iframe，不读取或传送文件内容。弹窗以自动换行output完整显示原始路径；启动直接使用此路径，服务端只stat核对可读文件。
- 消息验证宿主/iframe来源、requestId；拒绝相对路径、fakepath和控制字符。取消保留上次选择，来源切换、卸载和过期流程清理监听。无官方路径桥接的网页版明确提示使用桌面版或网络链接，不回退复制。
- 移除POST /api/internal-material-files及暂存目录写入代码，旧接口返回404。旧任务及历史已有文件不做删除，避免破坏重试来源。

新版仅改变平台获取来源路径的方式。后续由Agent将原始资料上传飞书的要求保留，上限仍100MB。
