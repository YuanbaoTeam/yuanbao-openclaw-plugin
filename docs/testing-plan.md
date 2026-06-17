# yuanbao-openclaw-plugin 自动化测试技术方案

> 目标：用分层自动化测试覆盖「代码改动 / 依赖升级 / 协议变更」三类破坏源，
> 把每次变更后的人工回归成本降到接近零。
>
> **本期范围**：单测 + 集成 + 覆盖率门槛（本仓自建）；版本兼容（已就绪）；E2E 由测试部门在 `YuanbaoPBGo` 流水线负责。
> 协议契约一期暂不做（见 §4.5）。

---

## 1. 背景与目标

`yuanbao-openclaw-plugin` 是连接元宝（Tencent Yuanbao）与 OpenClaw 的 channel 插件，
通过 **protobuf 帧 + HMAC 签名** 与元宝服务端通信，通过 **OpenClaw plugin-sdk** 与宿主集成。

当前痛点：每次变更后依赖人工连真机回归，成本高、易遗漏。本方案建立分层自动化测试，
让绝大多数破坏在本地 / PR 阶段被拦截。

**衡量标准**

- 本地 `pnpm test` 全绿 + 覆盖率不低于基线 → 才允许提交（pre-commit 已就绪）。
- PR 阶段跑通：单测 / 集成 / 协议契约 / 构建。
- 依赖升级（OpenClaw 新版本）由定时任务自动回归并告警。

---

## 2. 现状盘点

| 项 | 现状 |
|---|---|
| 运行器 | Node 原生 `node --test` + `tsx`，`pnpm test:coverage` 当前跑 **576 用例 ≈ 6s** |
| 已有单测 | 69 个 `src/**/*.test.ts`，采用 co-located 测试布局；旧 `test/*.mjs` 已迁移并删除 |
| 集成测试 | ✅ 已覆盖入站 gating、WS 建联/心跳/重连、gateway push 派发、outbound action、dispatcher/debouncer、群成员回填等关键链路 |
| 协议契约 | `test-contract/contract-exports.ts` 已暴露真实函数给 `yuanbao-bot-spec`；spec 仓已接 `compliance/openclaw/run.sh`（31 case 全绿），但**未接进本仓 PR 卡口** |
| 版本兼容 | `.github/workflows/upstream-compat.yml` 每 6h 检测 OpenClaw 新版本并回归，失败发企微告警 ✅ |
| 覆盖率度量 | ✅ `c8 --all` 全量度量 + CI/pre-commit 门禁；当前全局 **Lines 90.8% / Statements 90.8% / Functions 95.25% / Branches 80.73%** |
| CI | `ci.yml`：lint / test / build 三段 ✅ |
| pre-commit | `.githooks/pre-commit` 跑 lint + `test:coverage` + staged changed-lines coverage ✅ |

---

## 3. 测试分层模型

多层递进，各自守护不同的破坏源，**互不可替代**。下表含本期是否落地：

| 层 | 守护边界 | 「正确答案」来源 | 守护者 | 本期 |
|---|---|---|---|---|
| **单测** | 单个纯函数 / 单模块逻辑正确 | 我们自己定义 | `node --test` | ✅ 做 |
| **集成测试** | 多模块装配正确（链路行为） | 我们自己定义 | `node --test` + mock | ✅ 做 |
| **版本兼容** | 换 OpenClaw 底座后仍可编译 / 跑通 | OpenClaw SDK 实际行为 | `upstream-compat.yml` | ✅ 已就绪 |
| **E2E（接口自动化）** | 真机/真服务端全链路行为 | 真实元宝服务端 | `YuanbaoPBGo`（测试部门 + 流水线） | ✅ 他方负责 |
| **协议契约** | 与元宝服务端 / 规范对协议的理解一致 | 外部权威向量（`yuanbao-bot-spec`） | spec compliance runner | ⏸️ 一期不做 |

> 关键边界：
> - **版本兼容**管「插件 ↔ OpenClaw SDK」（上游）。
> - **E2E** 管「插件 ↔ 真实元宝服务端」的端到端行为，由测试部门在独立 Go 仓 `YuanbaoPBGo` 维护、配在流水线上，**本仓不写代码**。
> - **协议契约**管「插件 ↔ 元宝服务端 protobuf/签名」的离线向量一致性——与 E2E 互补（契约离线快、E2E 真机全）。一期暂不接入，留作后续增强。

### 分层判定流程

对每个待测对象问三连：

1. 改了它会不会和「对面」（元宝服务端 / spec 规范）对不上？ → **是 = 契约**
2. 否，它是单个纯函数 / 单模块？ → **是 = 单测**
3. 否，跨多个模块串起来？ → **集成**

> 同一文件可同时属于多层，角度不同不冲突。例如 `conn-codec.ts`：
> 单测测 `decode(encode(x)) === x` 自洽 + 异常字节不崩；契约测 `decode(固定字节)` 字段 === 规范向量；集成测「收帧 → gateway decode → 正确进 pipeline」。

---

## 4. 测试内容归类（本仓具体落点）

### 4.1 单测（确定性输入输出，答案我们说了算）

| 模块 | 测什么 | 现状 |
|---|---|---|
| `business/outbound/queue.ts` | 分片 / merge-text：split 边界、空串、最小字符合并 | ❌ 待补 |
| `business/commands/upgrade/utils.ts` | semver 比较 | ❌ 待补 |
| `business/commands/log-upload/extractor.ts` | 日志提取 | ❌ 待补 |
| `infra/reply-classify.ts` | reply 分类规则 | ❌ 待补 |
| `business/utils/markdown.ts` | `mdAtomic` 原子块切分 | ❌ 待补 |
| `messaging/handlers/*`、`pipeline/middlewares/*` | 单中间件 ctx 入→出 | ✅ 已有 |

### 4.2 集成测试（跨模块装配，单个零件对 ≠ 链路对）

复用现成 `src/business/pipeline/test-helpers/mock-ctx.ts`：

| 场景 | 构造 | 断言 |
|---|---|---|
| inbound gating | 真实 `MessagePipeline` 串 `skipSelf → skipPlaceholder → guardCommand → resolveMention`，尾部挂 sentinel | C2C/群聊、自发消息、空消息、占位符、@bot/未@ 的 keep/drop 决策 |
| outbound action | 真跑 `handleAction`，mock `createMessageSender` | `send` 拆 text/media、sticker/react 分发、目标解析失败、缺 runtime/wsClient、文本失败/媒体失败策略 |
| WS client | mock `ws` WebSocket + 真实 `conn-codec`/`biz-codec` 构造帧 | authbind、心跳、重连、kickout、请求/响应 msgId round-trip、超时、断开清理 |
| WS gateway | mock socket / 签票 / inbound handler | `startYuanbaoWsGateway` auth → statusSink → push decode → `handleInboundMessage` → abort teardown |
| dispatcher/debouncer | mock SDK debouncer factory，捕获 `buildKey`/`onFlush`；mock pipeline execute 并断言 ctx | session key 派生、/stop 控制队列、/btw 独立队列、单条/多条 flush 的 pipeline ctx、空 merge 跳过 |
| group member backfill | mock wsClient + seeded cache | `getMembers` 拉取/缓存/session sync、`resolveUsername`、`listKnownPeers` |

> 当前仍缺一条更厚的 in-process happy path：`PushMsg → wsPushToInboundMessage → handleInboundMessage → debouncer flush → pipeline → dispatchReply → outbound sender`。
> 现阶段已分段覆盖所有接缝；后续建议补这条闭环测试作为主链路 smoke。

### 4.3 E2E 接口自动化（真机 / 真服务端，他方负责）

- **位置**：独立仓 `YuanbaoPBGo`（`git.woa.com/yuanbao_tester_group/YuanbaoPBGo`），Go + Ginkgo BDD。
- **负责方**：测试部门维护，**配置在流水线上**；本仓（插件）**不写 E2E 代码**。
- **覆盖**：通过面向测试的元宝客户端 SDK（QUIC 信令 / CGI HTTP / IM / Media），跑真实服务端场景。
  其中 `testcase/openclaw/` 即针对本插件 OpenClaw Bot 链路的场景用例；`client/cgi/api_openclaw.go`、
  `client/signal/api_openclaw_proxy.go` 对应 OpenClaw Bot 的 HTTP / 信令接口。
- **与本方案的关系**：E2E 是最外层兜底，验证「插件 + 服务端」真实联调；本仓的单测/集成负责让问题**在 E2E 之前**就被本地拦截，降低 E2E 跑挂的概率与定位成本。
- **本仓动作**：无需写代码。仅在协议 / 行为有破坏性变更时，知会测试部门同步更新 `YuanbaoPBGo` 用例。

### 4.4 版本兼容（已就绪，保持）

`upstream-compat.yml`：拉最新 OpenClaw → 重跑 `lint + test + build`，matrix `2026.5.7` / `latest`。
其含金量取决于单测+集成的覆盖质量。

### 4.5 协议契约（一期不做，后续增强）

对 `yuanbao-bot-spec` 黄金向量做离线一致性校验，模块 / 向量映射如下（备查）：

| 模块 | 向量 | 测什么 |
|---|---|---|
| `access/http/request.ts` → `computeSignature` | `SIGN-001` | HMAC 签名值、拼接顺序、时间戳格式 |
| `access/ws/conn-codec.ts` → `decodeConnMsg` | `PROTO-001` | decode 给定字节得到的字段结构 |
| `infra/reply-classify.ts`、`utils/markdown.ts`、`queue.ts` | `POLICY-005/006/008/011` | mention 门控 / replyTo / 分片 |

> **一期暂缓理由**：E2E 已能在真机覆盖协议正确性；契约的增量价值（离线快速拦截 + 跨语言对齐）留待后续。
> 现有 `test-contract/contract-exports.ts` 与 `yuanbao-bot-spec` 接线保持不动，随时可在二期接入 CI。
> 注：上述 codec / signature 的 **单测**（round-trip + 健壮性）仍在一期 Phase 1 内做，不依赖契约层。

---

## 5. 覆盖率目标与缺口清单

### 5.1 目标（硬指标）

**可测试代码** 的核心指标采用棘轮门禁：

| 指标 | 真实基线（`c8 --all`） | 当前门禁 |
|---|---|---|
| Lines | 38.32% | **≥ 90%** |
| Statements | 38.32% | **≥ 90%** |
| Functions | 43.14% | **≥ 95%** |
| Branches | 70.84% | **≥ 80%** |

> **必须用 `c8 --all --src src` 度量**。默认 c8 只统计「被测试导入过」的文件，会把整个 WS 建联层等
> 未导入文件**隐藏**，给出虚高的 70%。`--all` 把未导入文件按 0% 计入，才是「所有代码」的真实覆盖。

**允许 exclude 的低收益/外部边界代码**（不计入分母，需在 `.c8rc` 显式列出并注释理由）：
纯 barrel `index.ts`、`logger.ts`、`*.proto` / `*.json`、类型声明、声明式 channel/setup wiring、以及混合 IO/CLI 编排模块。

> 注意：`business/utils/media.ts`、`commands/log-upload/extractor.ts`、`commands/upgrade/utils.ts`
> 目前包含部分已测纯逻辑，但也混入大量下载/上传/CLI shell-out 路径。直接纳回 coverage 会把全局 Lines 从 90.8% 拉到约 85.1%。
> 后续正确做法是拆出 pure helper 文件并纳入 coverage，或补足 IO mock 测试后再移出 exclude。

### 5.2 缺口清单（按优先级，覆盖你点名的签票 / WS 建联 / authbind）

**P0 — 完全未导入（当前 0%，且是协议/连接核心）**

| 模块 | 角色 | 测法 |
|---|---|---|
| `access/ws/conn-codec.ts` | **authbind / 连接帧** 编解码 | 单测 round-trip + `PROTO-001` golden |
| `access/ws/biz-codec.ts` | 业务消息编解码 | 单测 round-trip + 异常字节 |
| `access/ws/client.ts` | **WebSocket 建联** / 重连 / 心跳 | 集成：注入 mock socket |
| `access/ws/gateway.ts` | 收帧 → decode → 派发 pipeline | 集成：mock socket 驱动 |
| `access/ws/index.ts` | 启动编排 `startYuanbaoWsGateway` | 集成 |
| `business/actions/*`（deliver/handler/media/sticker/text/resolve-target） | 出站投递 | 单测 + 集成（mock send） |
| `business/inbound/index.ts`、`messaging/callbacks/recall.ts`、`system-callbacks.ts`、`mention.ts` | 入站/回调 | 单测 + 集成 |
| `dispatcher/*`（debouncer / session-queue / session-abort-manager） | 会话队列/中止 | 单测（含定时器/并发） |
| `business/tools/*`（group / member / remind） | 工具调用 | 单测（mock HTTP） |

**P1 — 已导入但远低于 90%**

| 模块 | 当前 Lines | 角色 |
|---|---|---|
| `access/http/request.ts` | **21.7%** | **签票 / HTTP 签名 / ticket** |
| `business/utils/markdown.ts` | 21.1% | markdown 原子块/分片 |
| `business/commands/upgrade/utils.ts` | 22.4% | semver / 升级逻辑 |
| `infra/cos.ts` | 25.6% | COS 上传 |
| `setup-core.ts` | 24.4% | setup 逻辑 |
| `accounts.ts` | 28.4% | 账号解析 |
| `business/trace/context.ts` | 36.2% | trace 上下文 |
| `messaging/directory.ts` | 37.5% | 成员目录 |
| `messaging/handlers/custom/link-card.ts` | 38.5% | 链接卡片 |
| `business/commands/upgrade/env.ts`、`access/http/main.ts` | 35~36% | 升级 env / HTTP 主流程 |
| `infra/env.ts`、`business/utils/media.ts` | 53% | 环境变量 / 媒体处理 |
| handlers `file.ts` / `video.ts` / `sound.ts` | 47~76% | 媒体消息处理 |

**P2 — 接近达标（补边界/分支即可）**：`utils.ts`(80) / `targets.ts`(79) / `dispatch-reply.ts`(81) / `chat-history.ts`(82) / `guard-*` 分支 / `ttl-db`(92) / `member`(94)。

---

## 6. 分阶段实施计划

目标是把全局四项指标拉到 90%。每个 Phase 可独立交付、独立 merge，按"先止血再爬坡"推进。

### Phase 0 — 覆盖率度量 + 门禁（半天，最高杠杆）

- 引入 `c8`（与 node test runner 天然兼容）。
- 新增 `.c8rc.json`：`all: true`、`src: ["src"]`、`exclude` 列出胶水代码、`check-coverage: true` + 四项 `lines/statements/functions/branches` 阈值。
- 脚本：
  ```jsonc
  // package.json
  "test:coverage": "c8 node --experimental-test-module-mocks --import tsx --test \"src/**/*.test.ts\""
  ```
- **阈值用"棘轮"策略**：初始阈值 = 当前真实值（lines 38 / funcs 43 / branch 70），**只升不降**；每个 Phase 完成后把阈值抬到该 Phase 实测值，最终锁定 90。CI `test` job 跑 `test:coverage`，低于阈值即失败。
- **验收**：`pnpm test:coverage` 用 `--all` 出报告并卡阈值；覆盖率回退时 CI 红。

### Phase 1 — P0 协议/编解码纯函数 + P1 签票（2~3 天，零/轻 mock）

把"本地自洽但真机易挂"的协议边界先打满：

1. `conn-codec.test.ts` / `biz-codec.test.ts`：round-trip + 异常字节不崩 + `PROTO-001` golden。
2. `request.test.ts` → 签票 / `computeSignature` / ticket：固定输入断言签名值（拼接顺序、时间戳格式），`SIGN-001` golden。
3. `queue` / `markdown` / `upgrade/utils`（semver）/ `log-upload/extractor` / `reply-classify` 纯函数补满。
4. `accounts.ts` / `infra/env.ts` / `cos.ts` 的纯逻辑分支（IO 用 mock）。
- **验收**：P0 编解码 + P1 签票相关文件 Lines/Funcs ≥ 90%；全局 Functions 明显抬升。

### Phase 2 — WS 建联 + 链路集成（3~4 天，mock socket）

覆盖 P0 里需要"装配"才能测的部分：

- **WS 建联/重连/心跳**：注入 mock WebSocket，测 `client.ts` 连接建立、断线重连、心跳、`gateway.ts` 收帧 decode → 派发。
- **inbound 集成**：复用 `mock-ctx.ts`，文本/图片/@机器人/引用走完整 pipeline，断言路由与是否回复（c2c + group）。
- **outbound 集成**：mock `wsClient.send`，验证 `actions/deliver` + `queue` 在 streaming / merge-text 下的发包序列。
- **dispatcher**：session-queue / debouncer / abort 的并发与定时器路径（用假定时器）。
- **取舍**：WS 用 mock socket 而非真连（真连需凭证 + 网络，不适合 CI；真连留给 E2E / 灰度）。
- **验收**：全局 Lines/Statements/Branches ≥ 90%；改中间件能在本地 ~1s 内暴露主链路破坏。

### Phase 3 — 收尾补齐到 90%（1~2 天）

- 扫 `c8 --all` 报告里剩余 < 90% 的文件（P2 边界分支、handlers file/video/sound、directory、link-card、trace 等）逐个补齐。
- 把 `.c8rc` 四项阈值锁定到 **90**。
- **验收**：`pnpm test:coverage` 四项指标全部 ≥ 90% 且 CI 卡死。

### Phase 4 —（已就绪，无需开发）E2E + 版本兼容

- **E2E**：测试部门在 `YuanbaoPBGo` 维护、配在流水线上，本仓不写代码。仅在破坏性变更时知会同步用例。
- **版本兼容**：`upstream-compat.yml` 已运行，保持不动。

> 协议契约（原 Phase 3）**一期不做**，详见 §4.5。后续二期如需接入，遵循「零运行时依赖、CI 临时 checkout spec」原则，
> 不把 `yuanbao-bot-spec` 写进插件 `dependencies`/`devDependencies`。

---

## 7. 对「提 PR 到 OpenClaw」的影响：无

依赖方向是单向的 **spec → 插件**，插件对 spec **零依赖**：

- `test-contract/` 不会被发布：不在 `package.json#files`（仅 `dist`/`openclaw.plugin.json`/`README.md`），
  也不在 `tsconfig.json#include`，**永不进 `dist/`**。
- E2E 仓 `YuanbaoPBGo` 是完全独立的 Go 仓，与插件无任何代码 / 依赖耦合。
- 契约 CI / runner 在 `.github/`，不随 npm 包 / dist 走，不进 OpenClaw core dist。
- 符合 OpenClaw「external plugin 自管依赖、不污染 core dist」的约束。

> 红线：**禁止**把 `yuanbao-bot-spec` 加进插件运行时依赖（二期接入也只用 CI 临时 checkout）。

---

## 8. 最终形态

| 层 | 命令 / 触发 | 负责方 | 拦截的破坏 | 本期 |
|---|---|---|---|---|
| 单测 | `pnpm test`（pre-commit + CI） | 本仓 | 单模块逻辑 bug | ✅ |
| 集成测试 | `pnpm test`（同上） | 本仓 | 跨模块装配 bug | ✅ |
| 覆盖率门槛（全局 90%） | `pnpm test:coverage`（CI，`--all`） | 本仓 | 覆盖率回退 / 新增未测代码 | ✅ |
| 版本兼容 | `upstream-compat.yml`（定时） | 本仓（已就绪） | OpenClaw 升级 breaking change | ✅ |
| E2E 接口自动化 | `YuanbaoPBGo` 流水线 | 测试部门 | 真机 / 真服务端全链路 | ✅ 他方 |
| 协议契约 | spec compliance runner | 本仓（二期） | 协议 / 签名离线漂移 | ⏸️ |

本期覆盖「代码改动」「依赖升级」破坏源，并由 E2E 兜底「真机协议 / 全链路」；离线协议契约留作二期增强。

---

## 9. 工具与取舍

- **保持 node 原生 + tsx**，不引入 vitest/jest（当前 576 用例已基于它，迁移无收益）。唯一新增 `c8`。
- **覆盖率必须 `--all`**：否则未导入文件（如整个 WS 建联层）被隐藏，给出虚高数字。
- **不追求 100%**：仅纯 barrel `index.ts` / `logger.ts` / `*.proto`/`*.json` / 类型声明可 exclude，且需注释理由；其余全部计入 90% 分母。
- **棘轮阈值**：CI 阈值只升不降，每个 Phase 完成后抬高，最终锁 90，防止后续 PR 稀释覆盖率。
- 每个 Phase 独立可 merge，CI / pre-commit 已就绪，无需额外编排。

---

## 10. 落地顺序建议

`Phase 0（度量+门禁）→ Phase 1（签票/codec 纯函数）→ Phase 2（WS 建联+链路集成）→ Phase 3（收尾到 90%）`

P0 缺口（签票 / WS 建联 / authbind）优先，它们既是覆盖率大头、又是线上最易出问题的协议/连接核心。
E2E 与版本兼容已分别由测试部门 / 定时任务覆盖，本仓不占工。协议契约留作二期增强。

---

## 11. 任务列表

> 估时为单人粗估，可并行。每个 Phase 收尾把 `.c8rc` 阈值抬到该阶段实测值（棘轮）。

### Phase 0 · 度量 + 门禁（已完成）

- [x] **T0.1** 安装 `c8`；新增 `.c8rc.json`：`all:true`、`src:["src"]`、`exclude` 注释理由、`check-coverage:true`
- [x] **T0.2** `package.json` 增 `test:coverage`
- [x] **T0.3** CI `test` job 改跑 `test:coverage`
- [x] **T0.4** 增加 changed-lines coverage：CI PR 阶段和本地 pre-commit 均会执行

### Phase 1 · 签票 / codec / 纯函数（已完成）

- [x] **T1.1** `access/ws/conn-codec.test.ts`：round-trip + 异常字节不崩 + `PROTO-001` golden（含 authbind/ping/ack 构造）
- [x] **T1.2** `access/ws/biz-codec.test.ts`：各 `encode*/decode*` round-trip + 异常字节
- [x] **T1.3** `access/http/request.test.ts`：**签票** / `computeSignature` / ticket，固定输入断言 + `SIGN-001` golden
- [x] **T1.4** 纯函数补满：`outbound/queue` · `utils/markdown` · `commands/upgrade/utils`(semver) · `commands/log-upload/extractor` · `infra/reply-classify`
- [x] **T1.5** `accounts` · `infra/env` · `infra/cos` 纯逻辑分支（IO mock）
- [x] **T1.6** 抬高 `.c8rc` 阈值

### Phase 2 · WS 建联 + 5 条链路集成（已完成）

- [x] **T2.1** 链路1 入站 gating：C2C / 群聊@ / 群聊未@(requireMention) / skipSelf / placeholder / 命令门禁
- [x] **T2.2** 链路3 WS 建联：mock socket 测 authbind 握手 → connected、心跳、断线重连退避
- [x] **T2.3** 链路3 收帧派发：`gateway` decode / `startYuanbaoWsGateway` push → `handleInboundMessage`
- [x] **T2.4** 链路2 出站：`handleAction` + mock sender，text/media/sticker 分发 + 失败策略
- [x] **T2.5** 链路4 dispatcher：session-queue 串行/并发 + abort 中止 + debounce 合并
- [x] **T2.6** 链路5 群成员回填：`recordMember` + `infra/cache/member` + `messaging/directory`
- [x] **T2.7** 抬高 `.c8rc` 阈值

### Phase 3 · 收尾到当前门禁（已完成）

- [x] **T3.1** 扫 `c8 --all` 剩余低覆盖文件逐个补齐
- [x] **T3.2** `.c8rc` 阈值锁定：Lines/Statements 90、Functions 95、Branches 80
- [x] **T3.3** 旧 `test/*.mjs` 迁移到 co-located `src/**/*.test.ts` 并删除 legacy `test/` 目录

### 后续优化建议

- [ ] **O1** 拆分 `business/utils/media.ts`、`commands/log-upload/extractor.ts`、`commands/upgrade/utils.ts` 的 pure helper 与 IO shell-out 编排；pure helper 纳入 coverage。
- [ ] **O2** 补一条 in-process 主链路 smoke：`PushMsg → wsPushToInboundMessage → handleInboundMessage → debouncer flush → pipeline → dispatchReply → outbound sender`。
- [ ] **O3** 持续减少弱断言（`doesNotReject`/`length > 0`），优先验证 pipeline ctx、reply dispatcher 入参、outbound item 序列。

### Phase 4 · 已就绪（无开发）

- [ ] **T4.1** E2E（`YuanbaoPBGo`，测试部门 / 流水线）——仅破坏性变更时知会同步用例
- [ ] **T4.2** 版本兼容（`upstream-compat.yml`）——保持

> 协议契约（二期）：现有 `test-contract/` 接线保持不动，需要时按「零运行时依赖、CI 临时 checkout spec」接入。
