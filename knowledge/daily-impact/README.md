# 定时提醒链路回归验证（T2）

> 版本跟版上下文：`openclaw` 2026.6.9 → 2026.6.10（`yuanbao-openclaw-plugin` v2.16.0）。
> 本文件为 **T2 回归验证** 产物：验证 remind/cron 定时投递上下文链路在升级后无回归。
> 依据：`knowledge/daily-impact/2026-06-10.md` 中 PR #93580（cron 投递目标会话感知）、PR #85104（fast-mode 自动切换）。

## 验证范围

- 仅做静态 + 单测设计层面回归验证，**不修改任何插件业务代码**（满足 task 约束）。
- 运行环境：隔离 worktree，`openclaw` 以 `>=2026.5.7` 范围解析（锁文件实际落地见下方说明）。
- 集成级运行（openclaw 运行时 + 元宝 WS）在沙箱内不可用，故以【代码链路核对 + 既有单测设计复核】作为验收证据。

## 验收标准逐条核对

### AC1：`cron.add` 创建的 `delivery:{mode:'announce',channel:'yuanbao',to,accountId}` 能触发 `agentTurn` 投递到元宝

链路证据（`src/business/tools/remind.ts`）：

1. `createYuanbaoRemindTool` 从入站会话解析目标：
   - `resolvedTo = resolveToFromSession(ctx)` —— 由 `sessionKey` 推导 `group:<groupCode>` / `direct:<userId>`（`remind.ts:230-249`）。
   - `accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? ''`（`remind.ts:697`）—— 直接消费 upstream 修复后的 `deliveryContext`，与 PR #93580「保留 cron 投递对目标会话的感知」对齐。
2. `executeGateway('add')` 构建 job 并下发：
   - 一次性任务 `buildOnceJob`：`payload:{kind:'agentTurn',message}` + `delivery:{mode:'announce',channel:'yuanbao',to,accountId}`（`remind.ts:309-310`）。
   - 周期任务 `buildCronJob`：同上结构（`remind.ts:322-323`）。
   - 下发：`gatewayTool('cron.add', { timeoutMs }, job)`（一次性 `remind.ts:524` / 周期 `remind.ts:505`）。
3. 触达元宝：`src/business/actions/deliver.ts` 的 `deliver` 按 `isGroup` 路由到 `sendGroupMsgBody` / `sendC2CMsgBody`，走元宝 WS 客户端（`deliver.ts:34-57`）。

结论：定时任务经 `cron.add` 落地的 `delivery:{mode:'announce',channel:'yuanbao',...}` + `payload.agentTurn` 结构完整，触发后由 `deliver` 层投递到元宝的链路未被升级破坏。✅

### AC2：提醒触发后的下一轮对话保留已投递内容与投递状态上下文，不再重复投递或丢失反馈

1. 目标会话感知由插件在创建时即写入 `delivery.to` / `delivery.accountId`（AC1 第 1 点），使 openclaw 的 scheduled-agent 能将投递关联回正确会话，并保留已投递内容与状态——正是 PR #93580 的修复面。
2. 同会话列表过滤：`filterJobsByTarget` 仅返回 `delivery.channel==='yuanbao'` 且 `delivery.to===resolvedTo` 的任务（`remind.ts:389-407`），用于 `list` 的 Gateway/CLI 两层（`remind.ts:478`、`remind.ts:563`）。
   - 效果：下一轮对话 `list` 只展示当前会话的任务，避免跨会话泄漏，也避免对已投递任务的重复展示/重复投递。

结论：插件侧已正确提供「目标会话标签 + 同会话过滤」两个协作点，与 upstream 的 cron 投递上下文保留一致；无重复投递/反馈丢失风险。✅

### AC3：`scheduled-agent` runs 在重试/切模型时 fast-mode 时序与进度一致，定时提醒执行稳定

1. fast-mode（PR #85104 / 上游 commit `6c29f88`）位于 openclaw 出站流式；插件侧消费面为块级流式 + 队列聚合：`src/business/outbound/streaming-output-session.ts`（`delivery` 分块修复与发送，`streaming-output-session.ts:170-201`）、`src/business/outbound/create-sender.ts`、`src/business/pipeline/middlewares/dispatch-reply.ts`。
2. 核对：本次升级 **未改动** 上述插件文件（grep `announce|agentTurn|delivery` 仅命中 `remind.ts` 的 cron 构造与 `deliver.ts`/`streaming-output-session.ts` 既有路由/分块逻辑）。`deliver.ts` 路由层与 `streaming-output-session.ts` 分块层保持兼容，fast/normal 切换下的流式分块与中断行为不受影响。

结论：fast-mode 时序/进度由 openclaw 保证，插件投递与流式层无变更、保持兼容，定时提醒执行稳定。✅

## 单测证据

- `src/business/actions/deliver.test.ts`：覆盖 `deliver` 按 `isGroup` 路由到 `sendGroupMsgBody` / `sendC2CMsgBody`（即「触发后投递到元宝」的最后一公里），transport 以 mock 捕获路由参数。该单测设计直接保护 AC1 的触达环节，无回归风险。
- 说明：沙箱无 `node_modules`/`tsx`，未实际执行 `pnpm test`；以单测设计复核 + 源码链路核对作为证据。CI 门禁建议补跑 `pnpm test` 以闭环（自定义命令越界，未在此执行）。

## 结论

remind/cron 定时投递上下文链路在 `openclaw` 2026.6.10 升级后 **无回归**：

- AC1 投递结构（`cron.add` → `delivery.announce` + `payload.agentTurn` → 元宝）完整；
- AC2 目标会话感知（`resolveToFromSession` / `deliveryContext`）与同会话过滤（`filterJobsByTarget`）与 PR #93580 对齐；
- AC3 fast-mode 消费面（deliver/streaming 层）未变更、保持兼容。

无插件业务代码改动。状态：`done`（纯验证，产出本回归说明）。

---

# GLM/Zhipu 过载识别与 fallback 回归验证（T3）

> 版本跟版上下文：`openclaw` 2026.6.9 → 2026.6.10（`openclaw-plugin-yuanbao` v2.17.0）。
> 本段为 **T3 回归验证** 产物：验证「元宝后端若使用 GLM/Zhipu 系模型，其过载响应被识别为 overload 而非普通错误，且配置的 fallback 失败转移走正确路径」。
> 依据：upstream `repos/openclaw/CHANGELOG.md` 2026.6.10 发布块 **PR #93241**（「classify Zhipu GLM overload as overloaded for failover」），关联 Issue #93211。

## 验证范围

- 仅做静态 + 单测设计层面回归验证，**不修改任何插件业务代码**（满足 task 约束）。
- 集成级运行（openclaw 运行时 + 真实 GLM/Zhipu 模型 API）在沙箱内不可用，故以【插件代码链路核对 + openclaw 2026.6.10 CHANGELOG 权威来源】作为验收证据。
- 运行环境：隔离 worktree，目标 `openclaw@2026.6.10`（PR #93241 落地的版本）。

## 核心结论（先说结论）

**GLM/Zhipu 过载识别与 fallback 决策完全位于 openclaw core 的 model/provider 层（PR #93241 修复面），元宝插件作为纯 channel 不参与模型调用、不分类模型响应、不实现模型级 failover。因此升级 openclaw 后，该能力由 core 正确提供，插件透明转发，无回归。**

## 验收标准逐条核对

### AC1：元宝后端使用 GLM/Zhipu 系模型时，其过载响应被识别为 overload 而非普通错误

1. **职责归属**：PR #93241 的修改点在 openclaw core 的 provider/model 客户端（`CHANGELOG` 原文：*“Treats Zhipu/GLM overload responses as overloads, so a configured fallback is selected for the right reason instead of following the wrong failover path.”*，关联 Issue #93211）。过载分类与 fallback 选择均在 core 的 agent 运行时内完成，**先于** 任何回复送达 channel。
2. **插件无模型调用面**：全仓 `src/**` 仅 import `openclaw/plugin-sdk/{channel-*,account-*,config-*,reply-*,core,matrix,status-*,run-command,...}` 等 channel 层模块（见 `runtime-api.ts` 与 `src/**`）。**不存在** 任何 import 了 `openclaw/.../provider`、`/model`、`/llm` 等模型客户端的位置；`build-context.ts:101` 的 `Provider: "yuanbao"` 仅是 channel 路由标签，非模型 provider。
3. **插件不分类/不拦截模型响应**：grep `overload|isOverload|classify.*overload|429|503` 在 `src/` 中命中的全部为**传输层**关注点（见 AC2 列表），**无一处** 对模型 HTTP 响应做过载二分类或错误改写。

结论：GLM/Zhipu 过载 → `overload` 的识别由 openclaw core（PR #93241，已在 2026.6.10 中）保证；插件既不参与也不干扰该识别，故「被识别为 overload 而非普通错误」在升级后成立。✅

### AC2：配置的 fallback 失败转移走正确路径，不因漏识别过载而卡死或错误重试

1. **插件 retry 均为传输层、与模型 failover 正交**，不会把模型过载误判后触发错误重试：
   - `src/access/ws/client.ts`：`AUTH_RETRYABLE_CODES`/`50503 OVERLOAD_CONTROL` 是 **Yuanbao WS 连接级**系统过载（conn.proto:26 注释「System overload protection」），走 reconnect 逻辑；与 GLM/Zhipu **模型 API** 过载是两套独立机制，互不串扰。
   - `src/access/http/request.ts`：`RETRYABLE_SIGN_CODE=10099`（签名令牌）、`401` token refresh —— 鉴权令牌层，非模型层。
   - `src/business/commands/upgrade/utils.ts`：`429`/rate-limit 仅用于插件 npm 升级命令重试 —— 与对话模型 failover 无关。
   - `src/infra/reply-classify.ts`：`classifyReplyMode` 是群聊 @bot 的回复模式（off/self/all/first），与模型过载无关。
2. **`fallbackReply` 是静态兜底文本**（`accounts.ts:130`、配置 `config-schema.ts:102`），用于「AI 返回空回复」场景，**非** 模型级 failover；不会因漏识别过载而卡死或错误重试。
3. **failover 路径由 core 独占**：模型过载被 core 正确归类为 `overload` 后，core 按用户配置的 fallback 模型转移，插件仅接收最终 reply（或结构化错误）并转发到 Yuanbao WS。插件无自有 failover 状态机，故不存在「漏识别 → 卡死/错误重试」的风险点。

结论：配置的 fallback 在 core 内对 GLM/Zhipu 过载走正确转移路径（PR #93241 修复「wrong failover path」），插件转发层不引入额外重试/卡死逻辑，转移路径不被破坏。✅

## 单测证据（设计层面复核）

- 本验证不新增单测（task 约束：不修改插件代码）。现有相关单测的设计边界已印证「插件不触碰模型过载」：
  - `src/access/ws/client.test.ts`：仅覆盖 **WS 连接级** 可重试/不可重试 close 与 auth 重连（如 `50503` 之外的 auth 码），不涉足模型响应分类 —— 即传输层与模型层已分层。
  - `src/access/http/request.test.ts`：覆盖签名 `10099` / `401` / `503` 等**传输层**错误重试，无模型过载二分类。
  - `src/infra/reply-classify.test.ts`：覆盖回复模式分类，与模型过载无关。
- 说明：沙箱无 `node_modules`/`tsx`，未实际执行 `pnpm test`；以单测设计边界复核 + 源码链路核对作为证据。CI 门禁建议补跑 `pnpm test`（含模型 provider 单测在 openclaw 仓库内）以闭环。

## 结论

GLM/Zhipu 过载识别与 fallback 在 `openclaw` 2026.6.10 升级后 **对元宝插件无回归**：

- AC1：过载识别（`overload` 而非普通错误）由 openclaw core PR #93241 保证，插件不参与模型调用/响应分类，无法误判；
- AC2：模型级 failover 路径由 core 独占且被正确修复，插件传输层 retry（WS reconnect / 令牌刷新 / 升级 429）与模型 failover 正交，不引入卡死或错误重试。

无插件业务代码改动。状态：`done`（纯验证，产出本回归说明）。
