# 设计与平台约束参考

本包的视觉和微信能力判断基于以下公开资料进行收敛；开发时仍应以当时最新微信官方文档与真机行为为准。

## Apple

- Apple — Adopting Liquid Glass
  https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass
- Apple — Liquid Glass
  https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass
- Apple — Designing for iOS
  https://developer.apple.com/cn/design/human-interface-guidelines/designing-for-ios

结论：玻璃材质应该主要承担导航和操作层级，避免所有内容卡片同时使用强玻璃效果；控件数量应克制，并优先保证清晰、可触达与适配。

## 微信小程序

- 微信小程序头像昵称填写能力：生产实现应使用用户主动填写昵称/选择头像的能力，而不是把 `wx.getUserProfile` 获取真实昵称头像作为基础流程。
- `wx.login`：用于微信身份登录，不需要用户把公开头像昵称作为登录前提。
- `wx.requestSubscribeMessage`：需要用户主动订阅；因此 V0.2 才把“到期提醒”作为增量能力，不影响 V0.1 主链路。
- 页面路由：Home 与 Detail 使用正常小程序页面栈；分享冷启动必须能直接进入 Detail。

可参考：
- 腾讯云微信登录实践：
  https://intl.cloud.tencent.com/zh/document/product/1219/68263
- 小程序订阅消息文档镜像：
  https://wdk-docs.github.io/wxadev-docs/framework/open-ability/message/subscribe-message.html
