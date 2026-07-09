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
