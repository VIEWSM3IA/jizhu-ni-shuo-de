# 记住你说的 · V0.2

微信群里的放话时间胶囊：创建一句话 → 分享到群 → 朋友各押一次同意/反对 → 到期由任一参与者开封。创建和押话后均不能编辑；截止前服务端只返回参与人数，结果仅参与者可见。

本仓库包含原生微信小程序 `miniapp/`、Node.js API `server/`、真实 PostgreSQL 集成测试 `tests/`，以及原始需求与交互原型 `docs/`。没有托管服务或微信小程序账号配置；公开 GitHub 仓库本身不能运行小程序。

## 运行 API

要求 Node.js 20+、PostgreSQL 17+、可用的微信小程序 AppID 与 AppSecret。先创建**专用数据库**，执行 `server/schema.sql`，然后在环境变量中配置：

```sh
npm ci
psql "$DATABASE_URL" -f server/schema.sql
WECHAT_APP_ID=你的AppID WECHAT_APP_SECRET=你的AppSecret DATABASE_URL='postgresql://user:password@localhost:5432/capsules' npm start
```

`PORT` 默认 3000。`GET /health` 仅检查 HTTP 进程。正式部署时将 API 放在 HTTPS 域名下，在微信后台配置为小程序合法请求域名，并使用受保护的数据库连接。AppSecret 和数据库密码只放服务端环境变量，不进入小程序或 Git。

服务端使用微信 `jscode2session` 建立身份，创建/押话前调用微信内容安全接口；接口不可用时拒绝写入，不会跳过审核。举报记录写入 `reports` 表，运营方需处理举报并建立下架流程。

## V0.2 一次性到期提醒

已有 V0.1 数据库须先执行 `psql "$DATABASE_URL" -f server/migrations/002_v02_reminders.sql`，再部署 V0.2 代码；全新数据库直接执行 `server/schema.sql`。迁移可重复执行，保留原有 Capsule 与 Stance。

在微信公众平台选定真实的一次性订阅模板后，服务端配置 `WECHAT_REMINDER_TEMPLATE_ID`、`WECHAT_REMINDER_TEMPLATE_FIELDS_JSON`、`WECHAT_MINIPROGRAM_STATE=trial`（正式版改为 `formal`）、`REMINDER_WORKER_ENABLED=true` 和可选的 `REMINDER_POLL_MS=30000`。字段映射示例为 `{"thing1":"title","time2":"local_time","thing3":"note"}`，键名和数据类型必须按实际模板核对。小程序 `miniapp/config.js` 的 `reminderTemplateId` 必须与服务端模板 ID 完全一致。仓库没有配置真实模板 ID 或凭证。

提醒仅由 SEALED 参与者主动请求一次性授权。worker 在开封时间后发送，最多尝试 3 次，24 小时后过期。微信已接收消息而服务端尚未写入 `sent` 时若进程崩溃，仍存在重复尝试窗口；不能宣称严格 exactly-once。

## 运行小程序

1. 在微信开发者工具中导入 `miniapp/`，将 `miniapp/project.config.json` 的 `touristappid` 改为自己的 AppID。
2. 将 `miniapp/config.js` 的 `apiBaseUrl` 改为已部署的 HTTPS API 域名，并配置真实 `reminderTemplateId`。
3. 用开发者工具预览/上传体验版；在 iOS、Android 微信真机分别测试登录、创建、分享冷启动、押话、到期和开封。

小程序未嵌入 HTML 原型；`docs/prototype/index.html` 仅供视觉对照。小程序使用微信原生导航、分享按钮与日期/时间选择器。

## 验证

验证分三层。第一层 `npm run check` 检查 JavaScript 语法、小程序页面/组件注册与引用，以及明显的客户端密钥误入；`npm run test:frontend` 覆盖创建时间状态与详情页到期刷新逻辑。第二层 `npm test` 运行前端测试和 PostgreSQL API 集成测试，且会**清空指定测试数据库的业务表**，务必只传可丢弃的测试库：

```sh
TEST_DATABASE_URL='postgresql://user:password@localhost:5432/capsule_test' npm test
```

测试直接启动 HTTP API，并覆盖字段校验、内容安全拒绝、创建事务与幂等、并发押话/开封、截止及撤销边界、列表排序、鉴权和结果隐私。GitHub Actions 在独立 PostgreSQL 服务中执行相同检查。

第三层必须在微信开发者工具中真实导入、编译和走查 Home → Create → Detail → 分享冷启动 → 另一账号押话 → 到期 → 开封 → 回 Home；再分别用 iOS、Android 真机检查系统胶囊、键盘、安全区、下拉刷新、前后台切换、弱网和长文本/emoji。当前仓库及 CI 没有可运行的微信开发者工具环境，因此这些项目在完成实测前标记为 **NOT RUN**。CI 绿灯只代表前两层通过，不能替代第三层。

V0.2 还需在体验版真机验证：主动点击提醒 → 微信 accept → 服务端 armed → 到期开封通知送达 → 点击通知冷启动到 `src=reminder` 详情。当前真实模板未配置，DevTools、iOS、Android、真实授权、送达与深链回跳均为 **NOT RUN**；自动化模拟测试不等于真实微信验收。

## 体验版与上线前事项

配置真实微信凭据和 HTTPS 域名后，在微信开发者工具上传体验版并邀请体验成员。正式上线前需要完成 `docs/V0.1_FROZEN_CHECKLIST.md` 的真机、微信内容安全、分享冷启动和运营处理验收；当前仓库中的自动化测试不能替代这些微信端实测。

若需回滚 API 版本，保留 PostgreSQL 数据和当前表结构，回退服务端与小程序代码版本；本版本没有破坏性迁移。已创建的 Capsule、Stance 和公开分享链接无法通过代码回滚撤销。
