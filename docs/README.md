# 「记住你说的」微信小程序 — V0.1 开发包

定位：**微信群里的“放话时间胶囊”**。不是预测平台，不做胜率、排行榜、积分或虚拟币。

一句话：**把朋友现在说的话锁住，等未来发生后再开封。**

## 本包内容

- `00_FINAL_PRODUCT_BLUEPRINT.md`：最终产品形态与不可偏离原则
- `01_VERSION_ROADMAP.md`：V0.1 → V1.0 Frozen 的逐版迭代
- `02_V0.1_PRD.md`：V0.1 完整需求
- `03_V0.1_INTERACTION_SPEC.md`：交互、状态、文案、异常流
- `04_V0.1_WECHAT_IMPLEMENTATION.md`：微信小程序实现约束与页面/组件结构
- `05_V0.1_DATA_API.md`：数据模型、API、并发与幂等要求
- `06_V0.1_ACCEPTANCE_TESTS.md`：验收用例
- `07_V0.1_ANALYTICS_AND_GUARDRAILS.md`：埋点与指标
- `08_V0.1_AGENT_HANDOFF.md`：可直接交给开发 Agent 的执行说明
- `V0.1_FROZEN_CHECKLIST.md`：冻结前检查表
- `prototype/index.html`：可直接打开的高保真交互原型
- `seed/demo_data.json`：Demo 数据

## V0.1 结论

V0.1 仅保留 **2 个页面 + 2 个 Sheet**：

1. 首页：参与过的“话” + 创建入口
2. 详情页：根据状态自动呈现“可押话 / 已封存 / 待开封 / 已开封”
3. 创建 Sheet：输入一句话 + 开封时间 + 群内称呼
4. 首次参与身份 Sheet：只填“群里怎么叫你”

创建成功后内容立即冻结，不提供编辑。发起人默认站在“同意”侧。其他用户每个话题只可押一次；截止前只显示参与人数，不显示任何人的选择。到期后任一参与者可以开封。

## 视觉原则

- **微信小程序认知优先，iOS 前沿视觉语言其次**。
- 无自定义底部 TabBar；无“App 化”的复杂导航。
- 内容层平整、清晰；导航与关键操作层可使用克制的半透明/玻璃材质。
- 大圆角、同心曲率、低饱和背景、轻阴影、弹簧式 Sheet 动效。
- 不依赖 iOS 私有视觉能力；WXSS 必须提供不透明 fallback。

## 打开原型

直接打开 `prototype/index.html`。原型内置 Home / Join / Sealed / Due / Opened 五种状态切换，创建和押话按钮可交互。
