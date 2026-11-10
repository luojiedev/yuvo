# 知余 Yuvo

*Every day, a little more room.*

**记下日常，心中有余。**

知余 Yuvo 是一款面向个人和家庭共同使用的本地优先记账 PWA。应用会先把账单和待同步操作写入浏览器 IndexedDB，保证弱网或离线时仍可记账；联网后再通过 Cloudflare Workers 将增量变更幂等同步到 D1，图片附件保存到 R2。

本仓库提供可独立部署的源码，不包含线上账本、账号、附件或生产密钥。每个部署实例使用自己的 Cloudflare 资源。

## 当前特性

### 快速记账

- 支持支出和收入，金额统一使用最小货币单位整数存储。
- 自绘数字键盘支持小数、退格以及加、减、乘、除连续计算，不唤起系统金额键盘。
- 支持选择账本、账户、日期时间、主分类和子标签，并填写账单描述。
- 支出和收入均提供“自定义”入口，可新增、编辑分类和维护子标签。
- 每笔账单最多选择三张图片；流水只显示附件标识，详情中可查看大图并关闭预览。
- 保存后立即写入本地数据库并更新流水，不等待网络请求。
- 支持 CNY/USD 原币记账；点击金额卡片中的币种即可切换，美元参考汇率自动获取且可人工修改。
- 外币流水冻结人民币结算金额和汇率快照，统计、预算、日历及金额筛选统一使用人民币口径。

### 流水、查询和统计

- 流水按本地日期分组，展示每日收入、支出合计和记录人。
- 点击流水进入详情；向左滑动可显示“编辑/删除”，详情页也可直接编辑或删除。
- 详情页、搜索页和记账页统一支持屏幕左边缘右滑返回。
- 日历视图按月展示每日支出，并支持年月滚轮切换。
- 搜索支持描述、分类、子标签、账户、记录人、金额和币种关键词。
- 可按时间、收支类型、金额区间、分类、账户、成员和是否参与统计组合筛选；默认搜索全部时间。
- 统计页支持月度与年度切换、同期收支对比、每日/每月趋势、分类/账户/成员排行，以及预算执行和期末支出预测；排行可下钻到精确周期内的参与统计流水。
- 日期分组和统计周期采用当前设备的本地时区；家庭成员位于不同时区时，同一笔临近零点的账单可能落入不同日期或月份。

### 预算

- 每个账本拥有独立的月度预算，默认值为 ¥3,000。
- 所有者或管理员可在预算页直接修改预算。
- “已使用”只汇总用户本地时区本月内、已到发生日期且参与统计的支出；外币使用冻结的人民币结算金额。
- 展示已用比例、剩余金额、按本月剩余天数动态计算的日均可用金额和预算状态。
- 预算修改先在本地生效，再通过现有 Outbox 同步到家庭成员的设备。

### 订阅与数据便携

- “我的 → 订阅管理”可维护服务名、使用人、金额、币种、周期和下次扣费日，并展示人民币月度预计费用。
- 订阅到期采用人工确认扣费；同一订阅周期使用稳定键生成流水，重复点击或同步重放不会重复入账。
- “我的 → 导入与导出”支持当前账本版本化 JSON 备份（包含当前设备已有附件）及 UTF-8 CSV 流水交换。
- JSON/CSV 重复导入可安全跳过；CSV 会防护公式注入并保留原币金额、汇率和人民币结算金额。

### 账号、账本与家庭共享

- 首位用户初始化系统；后续账号通过一次性邀请令牌创建，不开放公开注册。
- 每个自然人使用独立账号和独立设备标识，避免不同账号之间发生设备冲突。
- 每个账号拥有私人账本，并可创建或加入家庭账本。
- 登录时可将本机账本及全部账目接入为私人账本，也可在账本管理中接入；私人账本支持离线创建，联网后同步账号下所有账本及图片。
- 家庭账本支持 `owner`、`admin`、`member` 和 `viewer` 权限模型；当前界面以所有者和管理员共同维护为主要场景。
- 账单、分类、子标签、账户、附件和预算按账本同步，私人账本与家庭账本相互隔离。
- 流水保留创建人信息；修改个人展示名称后，其他设备同步后会更新记录人名称。
- 支持本地多账本切换、家庭账本创建、邀请令牌生成、账号登录/退出和会话自动续期。
- 本地存储按账号隔离，退出后锁定该账号的数据并保留待同步操作；旧版数据经在线核验后迁移，归属不明的数据保留并锁定。迁移细则和本轮发布状态见 [第一批可靠性调整](docs/first-batch-recovery.md)。

### 本地优先同步

- 业务实体和 Outbox 操作在同一个 IndexedDB 事务中提交。
- 每次操作携带稳定 `operation_id`；服务端保存幂等结果，重复请求不会重复创建数据。
- 更新和删除使用 `base_version` 乐观锁，冲突不会静默覆盖。
- 应用启动、网络恢复、回到前台和手动“立即同步”时执行增量同步。
- 启动采用缓存优先：先读取本地账本进入应用，再在后台静默拉取远端变化。
- 登录后可从 D1 快照恢复有权限的账本；附件内容通过鉴权接口从 R2 下载并缓存到 IndexedDB。
- 个人中心展示账号和同步状态，并提供立即同步与一键重新启动应用。

### PWA 与启动体验

- Service Worker 缓存应用外壳和构建资源，已安装应用可在离线时启动。
- 提供 Web App Manifest、标准/Maskable/iOS 图标和常见 iPhone 启动画面。
- 启动页即时显示本地加载阶段，启动文案由 D1 配置并随机展示。
- 支持安装状态、离线状态、版本更新提示和 iPhone“添加到主屏幕”说明。
- 登录用户可在个人中心开启系统通知；家庭账本其他成员新增账目后，即使应用未打开也能收到 Web Push，点击后会进入对应账本和账单。
- 推送订阅按用户与设备保存，同步操作重放不会重复创建通知；失效订阅会在投递时自动停用。
- 关键文本与金额输入控件按 iOS PWA 要求保持至少 16px，避免聚焦时页面自动缩放；新增表单需遵循 `AGENTS.md` 检查点。

## 技术架构

```text
React UI
  ↓ 只读写本地数据
IndexedDB（账本镜像、Outbox、同步游标、附件缓存）
  ↓ 批量推送 / 增量拉取
Cloudflare Workers API
  ├─ D1（账号、账本、账单、权限、同步变更、通知事件与订阅）
  ├─ R2（图片原文件）
  └─ Web Push（VAPID 加密后投递到浏览器推送服务）

Service Worker → 缓存应用外壳和静态资源
```

前端使用 React、TypeScript、Next.js/Vinext 和 Vite 构建；服务端运行于 Cloudflare Workers。D1 schema 使用 Drizzle 管理，所有生产结构变更通过 `drizzle/` 中的迁移文件发布。

## 当前边界

以下能力尚未完成，不能视为当前产品特性：

- 账户间转账与账户余额计算。
- 成员列表、移除/退出家庭账本和角色调整界面。
- 面向用户的同步冲突比较与处理界面。
- 账本编辑/归档、分类排序/恢复和完整附件删除回收。
- AI 自动分类；导入预览、任意 CSV 列映射、ZIP 流式大附件备份和全账本打包仍属于后续增强。
- 稳定的后台实时同步；iOS 会限制 PWA 后台执行，因此远端变化仍在启动、回到前台、恢复网络或手动同步时检查。

微信内置浏览器不在兼容范围，请使用系统 Safari、Chrome 或安装后的 PWA。

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 11.10

本项目只使用 pnpm。不要运行 `npm install`，依赖锁文件为 `pnpm-lock.yaml`。

## 本地开发

```bash
corepack enable
pnpm install
cp wrangler.example.jsonc wrangler.jsonc
pnpm run cf:migrate:local
pnpm dev
```

开发服务器监听 `0.0.0.0`，实际端口以终端输出的 Local URL 为准。同一局域网内的手机可通过电脑局域网 IP 和相同端口访问。

`wrangler.jsonc` 不进入 Git；本地 D1 和 R2 由 Cloudflare 模拟器运行，不会访问远端账本。仅查看离线界面时可以跳过本地数据库迁移，使用账号与同步 API 前需要执行迁移。

本地测试通知时，将 `.dev.vars.example` 复制为 `.dev.vars`，再填写自己的 VAPID 配置；不使用通知时无需创建该文件。

macOS 可使用以下命令查看 Wi-Fi 地址：

```bash
ipconfig getifaddr en0
```

## 检查命令

```bash
pnpm test
pnpm run test:local-db
pnpm run test:worker
pnpm run typecheck
pnpm run lint
pnpm run cf:types:check
```

- `pnpm test`：执行生产构建和前端领域/渲染测试。
- `pnpm run test:local-db`：运行 IndexedDB、搜索等本地数据测试。
- `pnpm run test:worker`：运行 Worker、D1 和 R2 集成测试。
- `pnpm run typecheck`：执行 TypeScript 类型检查。
- `pnpm run lint`：执行代码规范检查。
- `pnpm run cf:types:check`：检查 Worker 绑定类型是否与配置一致。

## Cloudflare 部署

先登录自己的 Cloudflare 账号并创建独立资源：

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create yuvo-db
pnpm exec wrangler r2 bucket create yuvo-attachments
```

将 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`，在本地配置中填写创建结果：

- 将 `name` 改为自己的 Worker 名称。
- 将 `database_id` 的占位 UUID 替换为新数据库 ID，并确认 `database_name` 和 `bucket_name` 与创建的资源一致。
- 为部署账号启用所需的 D1、R2 和 Images 功能；资源权限及费用由部署者管理。

保持以下绑定名称不变，供应用读取：

- `DB`：自己的 D1 数据库
- `ATTACHMENTS`：自己的 R2 存储桶
- `IMAGES`：Cloudflare Images 转换绑定
- `ASSETS`：前端静态资源
- `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`：Web Push 必需 Secret

首次启用通知前生成一组长期使用的 VAPID 密钥：

```bash
node --input-type=module --eval 'import { generateVapidKeys } from "@mmmike/web-push/vapid"; console.log(await generateVapidKeys())'
```

将输出的公钥、私钥和联系人（例如 `mailto:admin@example.com`）分别写入 Worker Secret：

```bash
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
pnpm exec wrangler secret put VAPID_SUBJECT
```

本地开发时可将同名变量写入不会提交的 `.dev.vars`。VAPID 密钥一旦已有用户订阅便应保持不变；更换公钥会要求所有设备重新订阅。

新增 D1 migration 时先迁移数据库，再部署 Worker：

```bash
pnpm run cf:migrate:remote
pnpm run cf:deploy
```

没有数据库结构变化时只需执行 `pnpm run cf:deploy`。部署前应完成类型、Lint、本地数据、前端和 Worker 集成检查。登录令牌、密码及其他密钥不得写入仓库。

`pnpm run build` 会读取本地 `wrangler.jsonc`；该文件不存在时使用示例配置完成本地构建。Cloudflare 插件生成部署配置，随后 `wrangler deploy` 使用该构建结果。部署前务必先填写自己的本地配置，示例 UUID 不能用于线上部署。

首次部署后立即打开自己的站点，创建首位所有者账号；首位账号初始化完成后，其他用户通过一次性邀请创建账号。源码公开不会开放已有实例的注册，也不会授予他人访问账本的权限。

启动文案位于 D1 的 `app_messages` 表。公开版自带通用文案，可修改自己数据库中 `placement = 'launch'`、`status = 'active'` 的记录来自定义显示内容；无需把私人文案提交到仓库。

项目的 `package.json` 保留 `private: true`，用于防止误发布 npm 包，不影响 GitHub 仓库公开或独立部署。

## 目录说明

- `app/`：React 页面、交互组件和全局样式。
- `lib/`：领域模型、IndexedDB 数据访问、搜索和同步引擎。
- `worker/`：Cloudflare Worker API、认证、权限、同步和附件服务。
- `db/` 与 `drizzle/`：D1 数据模型、迁移及迁移元数据。
- `public/`：Service Worker、Manifest、图标和启动画面。
- `tests/`：前端领域逻辑、渲染和本地数据库测试。
- `worker-tests/`：Worker、D1 和 R2 集成测试。
- `AGENTS.md`：本项目的本地 Agent 实施检查点。
- `DEVELOPMENT_PLAN.md`：当前能力、剩余工作和里程碑。
- `IMPLEMENTATION_PLAN.md`：更细粒度的历史实施清单。
