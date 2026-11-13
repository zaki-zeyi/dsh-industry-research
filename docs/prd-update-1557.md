# PRD1557 实现

来源：https://zcnnosk3k1j9.feishu.cn/wiki/LiujwLZvIirk8akSjyVcr0Axn4g

- PRD1554：本地来源由浏览器标准文件选择器确认，支持桌面和网页。浏览器不暴露绝对路径，点击启动后通过本机API流式导入真实文件，使用宿主路径解析。保留原文件名与字节，不依赖第三方插件或Electron私有API。取消选择保留原选择，关闭配置不创建任务，切换来源清除旧选择。
- 新增POST /api/internal-material-files，仅接受application/octet-stream。服务端校验文件名、绑定与来源，限制100MiB；支持无Content-Length的分块请求，超限返回413，中断和失败删除未完成目录。已导入文件保留供重试；任务创建请求失败时复用同一导入结果。
- PRD1557：历史AI任务移到全量信息库下级导航，保留状态筛选、继续会话及失败重试。

浏览器使用原生File对象；上传到的是DSH宿主。远程网页版的文件位于远端宿主，桌面版位于本机DSH数据目录。实际音视频转写质量与飞书写入仍需真实模型验收。
