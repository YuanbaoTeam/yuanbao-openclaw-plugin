# 方案与规划（plans）

本目录登记插件的中长期方案、规划，以及**前瞻性技术债（tech-debt）监控项**。
技术债监控项用于跟踪上游 openclaw SDK 契约的演化，在触发迁移条件时提醒插件侧提前适配。

> 文档语言：中文。引用代码统一用 `路径:行号`。

---

## 前瞻性技术债监控

### TD-2026-06-10-session-transcript-identity — storePath / 身份模式契约监控

- **登记版本**：2026.6.10（跟版任务 T4 登记）
- **关联上游模块**：`openclaw/plugin-sdk/channel-inbound`、`openclaw/plugin-sdk/session-transcript-runtime`、`openclaw/channels/session-envelope.ts`、`openclaw/channels/session.ts`
- **状态**：监控中（forward-looking，尚未需要代码改动）

#### 1. 现状确认（基于 2026.6.10 / 2026.6.11 源码）

- `resolveInboundSessionEnvelopeContext` **未被标记 `@deprecated`**。
  - 实现位于 `openclaw/src/channels/session-envelope.ts:7`，签名为身份模式：
    `{ cfg: OpenClawConfig; agentId: string; sessionKey: string }`，返回 `{ storePath, envelopeOptions, previousTimestamp }`。
  - **不存在 `sessionFile` 形参**：该函数自 2026.6.x 起即为纯身份模式（identity-based），由 `resolveStorePath(cfg.session?.store, { agentId })` 内部推导出 `storePath`。验收标准里“sessionFile 参数仍兼容接受 storePath 路径”在源码中已不成立——该参数本身不存在，身份模式即当前契约。
- 插件调用点与 2026.6.10 契约**静态一致、无编译/运行告警风险**：
  - `src/business/pipeline/middlewares/resolve-route.ts:23`：以 `{ cfg, agentId: route.agentId, sessionKey: route.sessionKey }` 调用 `resolveInboundSessionEnvelopeContext`，取回 `storePath` 写入 `ctx.storePath`。
  - `src/business/pipeline/middlewares/dispatch-reply.ts:99-100`（行号为当前代码实际位置，计划书所述 88-95 为旧偏移）：以 `recordInboundSession({ storePath, sessionKey, ctx, onRecordError })` 消费该 `storePath`，与 `openclaw/src/channels/session.ts:31` 的 `{ storePath: string; sessionKey: string; ... }` 签名吻合。
  - `recordInboundSession` 与 `resolveInboundSessionEnvelopeContext` 在 `openclaw/src/plugin-sdk/channel-inbound.ts` 及其转发目标中**均无 `@deprecated` 标记**（该文件内的 `@deprecated` 仅针对 `resolveInboundMentionDecision` / `buildChannelInboundEventContext` / `buildChannelInboundMediaPayload` 等无关 API）。
- `session-transcript-runtime` 的身份契约 `{ agentId, sessionKey, sessionId }` 为**推荐（preferred）**契约：
  - `openclaw/src/plugin-sdk/session-transcript-runtime.ts` 中 `SessionTranscriptTarget`、`resolveSessionTranscriptTarget`、`...ByIdentity`（如 `appendSessionTranscriptMessageByIdentity`、`publishSessionTranscriptUpdateByIdentity`）均以 `{ agentId, sessionKey, sessionId }` 为入参。
  - **相反**，遗留的“文件目标”路径 `SessionTranscriptLegacyFileTarget` / `resolveSessionTranscriptLegacyFileTarget` **已被标记 `@deprecated`**（`session-transcript-runtime.ts:52`、`64-65`、`129-130`）：注释明确“active transcript file target 仅为 legacy 过渡用途，将被移除”。

#### 2. 技术债描述

插件当前通过 `resolveInboundSessionEnvelopeContext` + `recordInboundSession` 走“身份模式 → `storePath`”链路完成入站会话落盘，并未直接依赖 `session-transcript-runtime` 的 legacy 文件目标。但上游已明确将 **legacy 文件目标路径**标记为 `@deprecated`，并把 **`{ agentId, sessionKey, sessionId }` 身份契约**作为推荐形态。一旦插件未来引入基于 `session-transcript-runtime` 的转录/回放能力，须直接采用身份契约，避免引入已被弃用的 legacy 文件目标。

#### 3. 未来迁移触发条件

> 触发条件（满足任一即视为需要启动迁移评估）：

1. `openclaw/plugin-sdk/session-transcript-runtime` 中的遗留文件目标 `SessionTranscriptLegacyFileTarget` / `resolveSessionTranscriptLegacyFileTarget` 被**移除**（注意：截至 2026.6.11 其仅被 `@deprecated`，尚未移除——即触发条件已“半触发”，应优先在采用该模块前完成身份契约适配）；
2. `resolveInboundSessionEnvelopeContext` 或 `recordInboundSession` 被标记 `@deprecated`，或入参结构从 `{ agentId, sessionKey }` 身份模式变更为其它契约；
3. 上游发布 notes / `CHANGELOG` 声明 storePath 落盘链路将在某大版本弃用 legacy 路径。

#### 4. 监控动作

- 跟版时（每次 2026.6.x → 后续版本）核对上述两条 `@deprecated` 标记的存续与移除状态。
- 若插件新增 `session-transcript-runtime` 相关调用，代码评审强制要求使用 `...ByIdentity` / `resolveSessionTranscriptTarget`（`{ agentId, sessionKey, sessionId }`），禁止使用 `SessionTranscriptLegacyFileTarget` / `resolveSessionTranscriptLegacyFileTarget`。
- 本项登记后无需立即改动业务代码（无 behaviour 变更），属前瞻性监控。
