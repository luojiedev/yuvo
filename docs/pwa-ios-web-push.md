# iOS 主屏幕 PWA 推送通知：原理、实现与生产实践

> 本文聚焦通过 Safari 添加到 iPhone 或 iPad 主屏幕的 PWA，不讨论 Android 厂商推送，也不讨论原生 iOS App 的 APNs SDK 接入。

## 一、PWA 为什么能够像原生 App 一样收到通知

从 iOS 和 iPadOS 16.4 开始，添加到主屏幕的 Web App 可以使用标准 Web Push。它使用 Push API、Notifications API 和 Service Worker，并通过苹果的系统推送基础设施把通知送到设备。

苹果官方明确说明，iOS 和 iPadOS 上的 Web Push 使用与原生应用相同的 Apple Push Notification service，也就是 APNs。通知可以出现在锁屏、通知中心以及配对的 Apple Watch 上。开发者不需要加入 Apple Developer Program，也不需要申请原生 APNs 证书。[WebKit：Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

这意味着，一个通过 Safari 添加到主屏幕的 PWA，在通知能力上已经不再只是“浏览器里的网页”。它会获得独立的主屏幕图标、应用身份、存储空间和系统通知设置，用户也可以像管理普通 App 一样，在 iOS 的“设置 → 通知”中管理它。

但它仍然不是原生 App：开发者使用的是跨浏览器 Web Push 标准，而不是直接调用 APNs Provider API。

## 二、完整推送链路

以家庭记账应用为例，当一个成员新增账目后，通知链路如下：

```text
成员 A 新增账目
  ↓
业务服务器保存账目和通知事件
  ↓
服务器查找账本中的其他成员
  ↓
服务器取得成员 B 的 PushSubscription
  ↓
服务器使用 VAPID 私钥签名，并加密通知载荷
  ↓
服务器向 PushSubscription.endpoint 发送标准 Web Push 请求
  ↓
Apple Push Notification service 接收请求
  ↓
iOS 把消息交给主屏幕 PWA 的 Service Worker
  ↓
Service Worker 调用 showNotification()
  ↓
通知出现在锁屏和通知中心
  ↓
用户点击通知，PWA 打开相应账本和账单
```

这条链路包含四个责任方。

### 1. PWA 前端

负责注册 Service Worker、申请权限、创建订阅，并把订阅信息上传到业务服务器。

### 2. 业务服务器

负责决定何时发送、发送给谁、如何去重，并使用 Web Push Protocol 加密和发送消息。

### 3. 苹果 APNs

负责系统级网络连接、排队、设备寻址和最终投递。你的服务器不需要知道设备 Token，也不需要直接调用原生 APNs API。

### 4. iOS 与 Service Worker

iOS 在消息到达时唤醒 Web App 的 Service Worker；Service Worker 必须展示用户可见的系统通知。

## 三、iOS Web Push 的前置条件

要让通知正常工作，需要同时满足以下条件：

1. 设备运行 iOS 或 iPadOS 16.4 及以上版本。
2. 网站通过 HTTPS 提供服务。
3. 网站拥有有效的 Web App Manifest。
4. Manifest 的 `display` 使用 `standalone` 或 `fullscreen`。
5. 网站注册了 Service Worker。
6. 用户已把 PWA 添加到主屏幕。
7. 用户主动点击了“开启通知”一类按钮。
8. 用户在系统权限弹窗中选择允许。
9. 服务器能够访问订阅返回的苹果 Push endpoint。

一个最小 Manifest 示例：

```json
{
  "id": "/",
  "name": "轻记账",
  "short_name": "轻记账",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

`display: "standalone"` 很重要。苹果将带有独立显示模式的主屏幕网站视为 Home Screen Web App；普通主屏幕书签不应被当作完整 PWA 能力的可靠载体。[Apple WWDC：What’s new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/)

## 四、为什么必须由用户点击按钮开启通知

iOS 不允许网页在加载后自动弹出通知权限请求。权限申请必须紧跟用户的直接操作，例如用户点击：

```text
开启账本通知
```

推荐的流程是：

```text
解释通知价值
  → 用户点击“开启通知”
  → 调用 Notification.requestPermission()
  → 权限为 granted
  → 创建 PushSubscription
  → 上传到服务器
```

不要在应用首次打开时立即请求权限。用户还不了解通知价值时，通常更容易拒绝；一旦选择拒绝，网页无法反复弹出系统权限框，只能提示用户前往系统设置重新开启。

权限申请示例：

```ts
async function enablePush(vapidPublicKey: Uint8Array) {
  if (!("serviceWorker" in navigator)
    || !("PushManager" in window)
    || !("Notification" in window)) {
    throw new Error("当前环境不支持 Web Push");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("用户没有允许通知");
  }

  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey,
  });
}
```

在 iPhone 上，如果网页还没有添加到主屏幕，应先引导用户完成安装，再显示通知开关。

## 五、PushSubscription 是什么

订阅成功后，浏览器会返回一个 `PushSubscription`，典型结构如下：

```json
{
  "endpoint": "https://example.push.apple.com/3/device/...",
  "expirationTime": null,
  "keys": {
    "p256dh": "...",
    "auth": "..."
  }
}
```

三个关键字段分别是：

- `endpoint`：服务器发送 Web Push 的目标地址。
- `p256dh`：用于加密通知内容的客户端公钥。
- `auth`：加密过程使用的认证秘密。

服务器应把订阅与当前用户、当前设备绑定，而不是只绑定用户名。一个用户可能拥有多台 iPhone、iPad 或多个独立安装的 PWA，每个安装实例都可能产生不同订阅。

推荐的数据结构：

```text
push_subscriptions
  id
  user_id
  device_id
  endpoint
  p256dh
  auth
  expiration_time
  revoked_at
  created_at
  updated_at
```

`endpoint` 和订阅密钥属于敏感数据。虽然它们不是账号密码，但获得完整订阅信息的一方可能尝试向该订阅发送消息，因此不应写入公开日志、前端分析平台或错误追踪详情。

## 六、VAPID 的作用

VAPID 是 Voluntary Application Server Identification 的缩写，用来证明发送请求的服务器持有与订阅时公钥对应的私钥。

一套 VAPID 配置通常包含：

```text
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

### VAPID_PUBLIC_KEY

前端调用 `pushManager.subscribe()` 时传入。浏览器会把该公钥与订阅关联。

### VAPID_PRIVATE_KEY

只保存在服务器，用于签名推送请求。它必须作为 Secret 管理，不能进入 Git、前端 Bundle 或普通环境变量配置文件。

### VAPID_SUBJECT

表示推送服务维护者的联系方式，通常使用：

```text
mailto:admin@example.com
```

或者：

```text
https://example.com
```

它不是通知标题，也不是加密密钥。它会进入 VAPID JWT 的 `sub` 字段，供 Push Service 识别和联系发送方。

VAPID 密钥一旦投入使用，应长期保持稳定。更换公钥后，使用旧公钥创建的订阅不能继续按原方式工作，通常需要用户重新订阅。

## 七、服务器如何发送通知

服务器不能把普通 JSON 直接 POST 到 endpoint。它需要完成：

1. 使用订阅的 `p256dh` 和 `auth` 加密载荷。
2. 按 Web Push 规范生成请求头。
3. 使用 VAPID 私钥签名 JWT。
4. 设置 TTL。
5. 向订阅 endpoint 发送 HTTPS 请求。
6. 根据状态码更新订阅与投递状态。

推荐使用实现 RFC 8291 和 `aes128gcm` 的成熟 Web Push 库，避免自行实现 ECDH、HKDF、AES-GCM 和 VAPID JWT。

伪代码如下：

```ts
await sendPushNotification(
  {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  },
  {
    title: "家庭账本有新账目",
    body: "小明新增了一笔支出 · 餐饮",
    url: "/?ledger=family&transaction=transaction-id",
    tag: "notification-event-id",
  },
  {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  },
  { ttl: 3600 },
);
```

发送请求中的 `endpoint` 应完全来自浏览器订阅。服务器不要自行拼接 APNs 地址，也不要把原生 APNs device token、Topic 和 `.p8` 密钥体系混入标准 Web Push。

## 八、Service Worker 如何显示通知

Service Worker 通过 `push` 事件接收消息：

```js
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const payload = event.data?.json() ?? {};

    await self.registration.showNotification(
      payload.title || "轻记账",
      {
        body: payload.body || "账本中有一笔新记录",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: payload.tag,
        data: {
          url: payload.url || "/",
        },
      },
    );
  })());
});
```

苹果不支持利用 Web Push 做不可见的静默后台任务。Service Worker 收到 Push 后应立即展示用户可见通知；如果应用反复接收 Push 却不展示通知，Safari 可能撤销该网站的推送权限。[Apple：Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)

因此，Web Push 不适合被当作“偷偷唤醒 PWA 同步全部数据”的通道。正确做法是：通知本身携带足够的可见内容，用户点击或应用回到前台后再进行完整同步。

## 九、点击通知后如何打开业务页面

Service Worker 可以处理 `notificationclick`：

```js
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const rawUrl = event.notification.data?.url || "/";
    const targetUrl = new URL(rawUrl, self.location.origin);

    if (targetUrl.origin !== self.location.origin) {
      targetUrl.href = self.location.origin;
    }

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    if (windows[0]) {
      await windows[0].navigate(targetUrl.href);
      await windows[0].focus();
      return;
    }

    await self.clients.openWindow(targetUrl.href);
  })());
});
```

必须校验目标 URL 与 PWA 同源，避免服务器数据、错误配置或攻击载荷把用户带到外部钓鱼页面。

对于本地优先应用，点击后的业务流程应是：

```text
打开目标账本
  → 拉取远端增量
  → 在本地数据库中找到目标账单
  → 打开账单详情
  → 如果账单已删除，则退回账本首页
```

不要假设通知点击时本地数据库已经拥有最新账单。

## 十、业务通知必须设计幂等性

Web Push 的“发送成功”不等于“用户只会看到一次”。以下环节都可能重试：

- 客户端离线操作重新提交。
- 业务接口超时后重放。
- 后台任务重试。
- 队列采用至少一次投递。
- 服务器在未知发送结果时再次发送。

记账场景可使用同步操作的 `operationId` 作为通知事件的幂等来源：

```text
notification_event_id = operation_id
```

如果需要为每个接收人建立独立事件，则可以使用：

```text
notification_delivery_id = operation_id + recipient_user_id + subscription_id
```

数据库应建立唯一约束，确保同一个账单创建操作即使被重放，也不会重复创建通知事件。

浏览器通知的 `tag` 也可以使用事件 ID：

```js
showNotification(title, {
  tag: notificationEventId,
});
```

相同 `tag` 可以帮助系统合并或替换重复通知，但它只能作为客户端体验保护，不能代替服务器幂等。

## 十一、使用 Transactional Outbox 避免丢通知

最危险的实现是：

```text
保存账单成功
  → 直接发送通知
```

如果账单已经提交，而进程在发送通知前中断，就会出现账单存在但通知永久丢失。

更可靠的方式是把账单和通知事件写入同一个数据库事务：

```text
数据库事务
  ├─ INSERT transaction
  ├─ INSERT sync_operation
  ├─ INSERT sync_change
  └─ INSERT notification_event
```

提交成功后，再由后台任务读取 `notification_event` 并投递。这种设计称为 Transactional Outbox。

基础版本可以使用 Cloudflare Worker 的 `ctx.waitUntil()` 在响应后投递；生产增强版可以接入 Cloudflare Queue，实现重试、退避和死信处理。

推荐保存：

```text
notification_events
  id
  ledger_id
  transaction_id
  actor_user_id
  title
  body
  target_url
  status
  attempt_count
  completed_at

notification_deliveries
  event_id
  subscription_id
  status
  last_error
  sent_at
  updated_at
```

## 十二、如何处理失效订阅

订阅不是永久有效的。以下行为都可能使订阅失效：

- 用户删除主屏幕 PWA。
- 用户清除网站数据。
- 用户重新安装 PWA。
- 浏览器刷新订阅。
- 用户退出账号。
- 系统或 Push Service 吊销订阅。

当 Push Service 返回 `404` 或 `410` 时，通常应把订阅标记为失效，停止继续发送：

```text
revoked_at = current_time
```

用户下次登录并打开 PWA 时，可以调用：

```ts
registration.pushManager.getSubscription()
```

如果仍有本地订阅，则重新上传并绑定当前账号；如果没有，则显示“通知未开启”。

退出账号时也应停用当前设备订阅，否则用户退出后仍可能看到属于原账号的敏感通知。

## 十三、通知内容与隐私

通知会出现在锁屏上，不能假设只有账号本人能够看到。因此家庭记账通知不应默认展示：

- 精确金额。
- 完整备注。
- 商户名称。
- 附件缩略图。
- 可能暴露健康、行程或私人关系的信息。

更稳妥的默认文案是：

```text
家庭账本有新账目
小明新增了一笔支出 · 餐饮
```

可以提供用户设置：

```text
通知预览
  ○ 隐藏全部详情
  ● 显示收支类型和分类
  ○ 显示金额
```

服务端日志也不应记录 endpoint 全文、订阅密钥、通知备注或 VAPID 私钥。

## 十四、为什么通知可能没有立即出现

服务器成功发送并不代表用户一定立即看到。最终展示可能受到以下因素影响：

- 用户关闭了 PWA 通知权限。
- PWA 被删除。
- 设备没有网络。
- 订阅已经失效。
- iOS 开启了专注模式。
- 通知进入定时摘要。
- 系统根据用户设置静默展示。
- Service Worker 没有调用 `showNotification()`。
- VAPID 密钥与创建订阅时使用的公钥不一致。
- 服务器无法连接订阅的 Apple Push endpoint。

Web Push 适合重要提醒，但不应承担金融记账数据的一致性。账本数据仍然需要通过常规 API 和同步协议拉取，通知只是告诉用户“有变化发生”。

## 十五、iOS 实机排查步骤

出现无法接收通知时，可以按顺序检查：

1. 确认系统版本不低于 iOS 16.4。
2. 确认从主屏幕图标启动，而不是 Safari 标签页。
3. 确认 Manifest 使用 `standalone` 或 `fullscreen`。
4. 确认页面和 Service Worker 都通过 HTTPS 加载。
5. 检查 `Notification.permission` 是否为 `granted`。
6. 检查 `pushManager.getSubscription()` 是否返回订阅。
7. 确认订阅已经上传并绑定正确用户、设备。
8. 确认服务器使用与订阅一致的 VAPID 公钥和私钥。
9. 查看服务器向 endpoint 发送后的 HTTP 状态。
10. 检查 Service Worker 是否收到 `push` 事件。
11. 检查 `showNotification()` 是否抛出错误。
12. 检查 iOS“设置 → 通知”中的 PWA 权限。
13. 检查专注模式和通知摘要。
14. 删除主屏幕 PWA、重新安装并重新订阅，排除陈旧订阅。

测试至少需要两个独立账号和两台设备：

```text
iPhone A / 用户 A：新增账目
iPhone B / 用户 B：接收通知
```

还应测试：

- PWA 正在前台。
- PWA 在后台。
- PWA 已从任务切换器移除。
- 设备锁屏。
- 设备短暂离线后恢复。
- 用户关闭再重新开启通知。
- 用户退出账号。
- 同一个记账操作重复同步。
- 通知到达后账单已被删除。

## 十六、生产上线检查清单

### PWA

- [ ] Manifest 的 `display` 为 `standalone` 或 `fullscreen`。
- [ ] Manifest 包含稳定的 `id`、`start_url` 和 `scope`。
- [ ] 图标可以从公网 HTTPS 正常访问。
- [ ] Service Worker 已正确注册和更新。
- [ ] `push` 事件始终展示用户可见通知。
- [ ] `notificationclick` 只允许同源跳转。

### 权限与订阅

- [ ] 只在用户点击后请求通知权限。
- [ ] iOS 未安装时先展示添加到主屏幕说明。
- [ ] 订阅绑定用户和设备。
- [ ] 退出账号时停用订阅。
- [ ] `404/410` 响应会使订阅失效。
- [ ] 不在日志中输出完整订阅。

### VAPID

- [ ] VAPID 私钥使用 Secret 保存。
- [ ] 公钥与私钥属于同一密钥对。
- [ ] `VAPID_SUBJECT` 是有效的 `mailto:` 或 HTTPS 地址。
- [ ] 生产环境不会随部署重新生成 VAPID 密钥。

### 业务与可靠性

- [ ] 账单和通知事件在同一数据库事务写入。
- [ ] 通知事件具有唯一幂等键。
- [ ] 不通知操作人本人。
- [ ] 私人账本不产生家庭通知。
- [ ] 通知默认不暴露敏感金额和备注。
- [ ] 记录事件状态、投递状态和错误原因。
- [ ] 后续可以接入队列重试与死信处理。

## 十七、结论

iOS 主屏幕 PWA 的通知建立在开放的 Web Push 标准之上，但设备侧最终依赖苹果的 APNs。Safari 负责帮助用户创建主屏幕 Web App 和推送订阅；业务服务器负责通知规则、VAPID 签名、消息加密、幂等和投递；苹果负责系统级连接、权限策略和最终到达设备。

它与原生 APNs 共享苹果的推送基础设施，却不要求开发者账号、Bundle ID、APNs 证书或原生 SDK。对于家庭记账、协作提醒和状态变化通知，这套能力已经能够提供接近原生 App 的体验。

真正决定系统能否稳定运行的，不只是调用 `showNotification()`，而是完整处理订阅生命周期、事务一致性、幂等、隐私、失效清理、点击后的数据同步以及真实设备测试。

## 参考资料

- [WebKit：Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Apple：Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [Apple WWDC23：What’s new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/)
- [WebKit：Badging for Home Screen Web Apps](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)
