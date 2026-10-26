# Stronger 小程序

Vue 3 + TypeScript + uni-app，使用 pnpm。本次提供微信／开发登录、会话刷新与退出、身体档案的 API 封装，页面仍为原空训练演示，尚未接入微信入口或档案表单。

```bash
pnpm install
pnpm run type-check
pnpm test
pnpm run build:mp-weixin
```

`src/api.ts` 中 apiBaseURL 默认为本机服务地址。真实微信调试需配置小程序 AppID、可访问的 HTTPS 服务地址及合法请求域名；服务端微信配置见后端 README。

- `wechatLogin()` 内部获取微信 code；`developmentLogin()` 保留演示页面入口。
- `getProfile()`／`updateProfile()` 读取和保存本人档案；身高体重传十进制字符串，选填字段省略保留、null 清空。
- `refreshSession()` 共用在途刷新；业务 HTTP 401 且 code=100002 时自动刷新后最多重试一次，网络失败不自动重放写入。
- `logout()` 立即清除本地会话，并等待在途刷新后撤销当前凭证；撤销失败会拒绝 Promise，本地仍保持退出。

凭证存于 `stronger.session`，重新加载时恢复。登录与退出使用会话代次和串行队列，旧响应不会覆盖新账号；迟到的认证成功凭证仅尽力撤销。请求及微信 code 获取均限制 10 秒。认证接口不参与业务自动刷新。

自动化测试使用模拟 uni API，验证调用契约、并发、超时与迟到响应；微信开发者工具和真机登录需要单独验收。

错误码统一由 api.ts 导出的 ErrorCode 提供。APIError 保存 status、code（number 或 null）、message 和可选 parameter；业务判断使用 ErrorCode 常量，不匹配提示文案。未知整数码原样保留，网关 HTML、空响应、旧字符串码等使用 code=null 和本地通用提示，不触发自动刷新。后端与本客户端需同步升级数字错误码契约。

## 请求错误定位

`api.ts` 在错误响应中读取 `X-Request-ID`，保存在可选的 `APIError.requestId`。JSON 和网关非 JSON 错误都保留响应头 ID；网络失败或超时尚未收到响应时不生成 ID。反馈接口问题时可提供该 ID，服务端据此关联日志。刷新、重试和并发请求分别保留自身错误 ID，不修改成功数据和会话行为。
