# A2UI v1.0 Express 接入技术方案

> 目标：让 OpenClaw 模型用 A2UI Express 产出元宝 xCard，由插件编译并归一化成现有 A2UI v1.0 线包，复用当前发送、更新、回执和事件链路。
>
> **本期范围**：自由创作卡片增加 Express 输入，两个入口：`<a2ui>` 正文块自动入口、`yuanbao_xcard_send` / `yuanbao_xcard_update` 的 `express` 参数。IM 101/102/103 信封、Surface 注册和事件校验不改。附带改动：`yuanbao_xcard_template` 重新注册并支持私聊；宿主 SDK 升级到 2026.11.4（见第 6.3 节）。
>
> 官方依据：[SDKs](https://a2ui.org/concepts/sdks/)、[Inference Formats](https://a2ui.org/concepts/inference-formats/)、[How to Integrate A2UI into an Agent](https://a2ui.org/guides/agent-integration/)。

---

## 1. 结论

Express 是 Agent SDK 的推理格式，不是新的客户端协议。模型写 compact Express，服务端编译成标准 `AgentToRendererMessage[]`，元宝客户端仍然只接收 A2UI v1.0 JSON。

不能把官方 SDK 的编译结果原样交给 `createGeneratedCard()`。官方 v1.0 Express 默认把组件和数据折进一条 `createSurface`，当前 generated 链路按三段消息工作：

1. `createSurface`：catalog 与 metadata。
2. `updateComponents`：完整组件树。
3. `updateDataModel`：数据。

接入点是 `parseGeneratedMessages()` 同层的编译层，以及其后的归一化层。归一化之后继续走现有校验、Surface 重写、101 发送和 103 更新。

`<a2ui>...</a2ui>` 到 A2UI message array 的转换在 `yuanbao-openclaw-plugin` 内闭环。实测 openclaw 2026.11.4 的 `dist` 里没有任何 a2ui 相关解析，宿主不会把 `<a2ui>` 拆成结构化 reply part，所以插件同时接受两种形态：宿主将来可能给出的结构化 a2ui part，以及模型直接输出的整段 `<a2ui>` 文本块。

入口分工（提示词、工具描述、Skill 三处口径一致）：

| 入口 | 适用场景 | 失败处理 |
|---|---|---|
| `<a2ui>` 正文块（默认） | 一次性展示的自由卡片 | 不能同轮自纠错；给用户发「卡片生成失败，请稍后重试。」 |
| 工具 `express` 参数 | 需要 `waitForAction`、指定 `mode` / `audience` / `title`、更新已有卡片、正文块失败后同轮重试 | 返回可重试错误和修正提示，模型改 `express` 后重调 |
| 工具 `messages` 参数 | 已有 JSONL 兼容产物 | 沿用原 JSONL 校验 |
| `yuanbao_xcard_template` | 标准选择、表单、列表、确认、信息卡 | 字段级错误回给模型 |

不新增 `yuanbao_xcard_express_send` / `yuanbao_xcard_express_update`。`mode`、`audience`、等待、限流、回执和更新策略已经在现有两个工具里，复制一套会分叉。

不把 SDK 的完整 `promptSnippet` 写进每轮提示词。`targets.ts` 的 `buildMessageToolHints()`（由 `channel.ts` 的 `messageToolHints()` 引用）只放几条短规则；完整语法和组件签名由构建期生成的 `express-prompt.md` 提供。

---

## 2. 现状

### 2.1 自由创作链路

```text
模型
  ├─ 最终回复 <a2ui>...</a2ui>
  │    → dispatch-reply deliver → reply-part.ts
  └─ yuanbao_xcard_send / yuanbao_xcard_update
       → generated-input.ts
  → compileExpressMessages() / parseGeneratedMessages()
  → validateGeneratedMessages()       协议、catalog、自包含约束
  → createGeneratedCard() / updateGeneratedCard()
  → renderGeneratedMessages()         重写 surfaceId，注入可信 metadata 和 /__openclaw
  → transport-im1007                  101 创建 / 103 增量更新
  → 客户端 102 upevent
  → events.ts                         校验 action、revision、audience，回 103 ack
```

对应代码：

| 职责 | 文件 |
|---|---|
| 发送工具 | `src/business/tools/xcard-send.ts` |
| 更新工具 | `src/business/tools/xcard-update.ts` |
| 模板工具 | `src/business/tools/xcard.ts` |
| 工具输入准备 | `src/business/xcard/generated-input.ts` |
| Express 编译与归一化 | `src/business/xcard/express.ts` |
| `<a2ui>` 自动入口 | `src/business/xcard/reply-part.ts`、`src/business/pipeline/middlewares/dispatch-reply.ts` |
| 解析与渲染 | `src/business/xcard/generated.ts` |
| 生命周期 | `src/business/xcard/service.ts` |
| 结构校验 | `src/business/xcard/validate.ts` |
| IM 信封 | `src/business/xcard/transport-im1007.ts` |
| 事件 | `src/business/xcard/events.ts` |
| Surface 状态 | `src/business/xcard/registry.ts` |
| 协议常量 | `src/business/xcard/constants.ts` |
| 模型提示 | `src/business/messaging/targets.ts` |

`src/business/tools/index.ts` 注册 template、send、update 三个工具。template 工具改为按 `resolveYuanbaoConversation()` 识别群聊和私聊，卡片归属从「当前群」改为「当前会话」（`isGroup` + `targetId`），私聊等待时不暂停群心跳。

### 2.2 线上线包形状

模板卡源码构造是三条消息。AI 自由卡的归一化源消息也以同样的三段为基底；真正发送 101 前，`renderGeneratedMessages()` 会再追加插件投影 `/__openclaw`，所以 generated 卡最终是三段基底加一条插件状态消息。模板构造见 `src/business/xcard/templates/builder.ts`：

```ts
[
  { version: "v1.0", createSurface: { surfaceId, catalogId, metadata } },
  { version: "v1.0", updateComponents: { surfaceId, components } },
  { version: "v1.0", updateDataModel: { surfaceId, path: "/", value } },
]
```

固定口径：

| 项 | 当前值 |
|---|---|
| `version` | `"v1.0"`。其他值客户端回 `UNSUPPORTED_VERSION` |
| `catalogId` | `https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json` |
| 数据绑定 | `{ "path": "/flight/number" }` |
| 单包上限 | `MAX_CARD_CONTENT_BYTES = 10 * 1024`，按编译后的自定义 data 与同消息前后文本的 UTF-8 字节总和计算 |
| 可信 metadata | `createSurface.metadata.extensions.com_tencent_yuanbao_openclaw` |
| 操作结果投影 | 插件追加 `updateDataModel`，path 为 `/__openclaw` |

101 的 `content` 是消息数组。103 `state_update.content` 是去掉 `createSurface` 之后的增量消息。`surfaceId`、`audience`、`mode` 和 OpenClaw metadata 由插件决定，模型不能指定路由身份。文档里说“三段式”时指归一化后的 generated 源消息，不包含发送时由插件追加的 `/__openclaw` 投影。

### 2.3 现有代码对消息形状的假设

这些假设决定了为什么不能直接发送官方编译结果：

| 代码 | 假设 | 官方 v1.0 Express 默认结果 |
|---|---|---|
| `extractGeneratedActions()` | 事件只在 `updateComponents.components` | 组件在 `createSurface.components`，事件白名单为空，点击被 `invalid_action` 拒绝 |
| `renderGeneratedMessages()` 关闭卡片 | 只在 `updateComponents` 里把 `root.enabled` 设为 `false` | 关不掉卡片 |
| `renderSurfaceUpdateMessages()` | 丢掉全部 `createSurface`，留下组件和数据更新 | 103 只剩插件补的 `/__openclaw`，组件树和业务数据丢失 |
| `validateA2uiMessages()` | 允许 `createSurface.components`，所以结构校验仍可能通过 | 校验通过不代表生命周期正确 |

`validateA2uiMessages()` 继续作为安全网，不替代归一化。

---

## 3. 官方 Express 在本链路中的位置

官方 SDK 分三层：

| 层 | 包 | 本插件是否使用 |
|---|---|---|
| Core | `@a2ui/web_core@^0.15.0` | 使用。`Catalog.fromJson()` 加载派生 catalog |
| Agent | `@a2ui/agent@^0.1.0` | 使用。负责 prompt 语法和 Express 编译 |
| Renderer | `@a2ui/react` 等 | 不使用。渲染在元宝客户端 |

Express 的服务端流程是：

1. `CatalogConfig` 提供组件契约。
2. `ExpressFormatFactory` 作为推理格式，`allowedMessages` 限定三种消息。
3. `A2uiGenerator.createProcessor()` 按客户端 catalog 能力创建 processor。
4. `parseResponse(source, { wrapped: false })` 编译 Express 正文，得到 `AgentToRendererMessage[]`。

工具调用和 `<a2ui>` 正文块都是整段交付，卡片也是整包发送。使用 `parseResponse()`，不使用 `openStream()`，也不把半成品 surface 推到 IM。

### 3.1 Catalog 事实源与派生

catalog 不另写一份。事实源继续使用仓库已维护的渲染契约：

```text
skills/xcard-generator/references/specification/v1_0/catalogs/xcard/catalog.json
```

它按 `skills/xcard-generator/references/catalog-maintenance.md` 与目标 renderer、静态校验器和样例同步维护。当前文件是元宝渲染端的简化形状，由 `scripts/generate-a2ui-agent-catalog.mjs` 在构建期派生，输出不手改：

| 输出 | 用途 |
|---|---|
| `src/business/xcard/agent-catalog.json` | 运行时传给 `Catalog.fromJson()` 做 Express 编译与 SDK 校验 |
| `skills/xcard-generator/references/express-prompt.md` | Express 提示词快照，供模型写 Express 前读取 |

派生步骤（已实现）：

1. 保留 `catalogId`、`components`、`functions` 和本地 `$defs`，`catalogId` 不改名。
2. 方言转换，只改派生产物：
   - 单属性 `{ path }` 绑定 schema 改成 `{ "@path" }`，对齐 SDK 的绑定写法；
   - `child` 字符串改成 `common_types.json#/$defs/Child`，`children` 改成 `ChildList`，让模型能直接嵌套子组件，不手编组件 id。
3. 组件缺少 `component` 属性时补 `component: { "const": "<组件名>" }` 并加入 `required`。
4. 裁剪禁用组件 `WebCard`、`xCardTemplate`（29 → 27 个组件）。函数 34 个全部保留。
5. 顶层 `instructions` 写在脚本里：自包含、禁用效果、根节点命名为 `root`、交互卡要有结果态和 `resultText`。`mode`、`audience`、等待和回执是工具语义，不写进 catalog。
6. `metadata.extensions.openclaw_agent_catalog` 记录来源和 canonical 的 `sourceSha256`。
7. 最后合成 `$defs.anyComponent` / `$defs.anyFunction`，`oneOf` 只覆盖裁剪后的组件和函数，分别以 `component` / `call` 做 discriminator。

canonical catalog 的线包方言不动，元宝渲染端继续认 `{ "path": ... }`；`@path` 在归一化阶段改回 `path`（第 5.3 节）。

漂移检查：`pnpm xcard:agent-catalog:check` 重新生成并逐字比较两份产物，不一致时退出码 1。

未实现，留作后续（见第 10 节）：

- 函数 schema 仍是元宝简化形（`parameters`），未转成官方 FunctionCall 的 `args` + `call` const。当前 SDK 能加载并编译，暂不转换。
- 无独立 overlay 文件，`instructions` 直接写在脚本里。
- 未接入 CI。

### 3.2 Agent 如何学习 Express

`express-prompt.md` 由四部分拼成：

1. SDK `processor.promptSnippet`：语法规则、由派生 catalog 推导出的组件与函数签名。
2. 一处改写：把官方「必须用 `<a2ui>` 包住」的 IMPORTANT 句改成元宝口径——最终回复直接嵌入一个裸露 `<a2ui>` 块，前后可有普通文案，但块本身不能包在 Markdown/code fence 里；传给工具 `express` 参数时只传正文、不带标签。
3. 开头手写的「Compact Express Quick Reference」段：把 one-shot 卡片需要的最小心智模型放在长签名前面，包括 `root`、`_template`、相对绑定和 `Text.variant` 枚举。
4. 末尾手写的「Yuanbao OpenClaw Runtime Contract」段：默认路径与工具路径的分工、自包含禁用项、结果态与 `resultText`、同一业务优先 update。

同一份派生 catalog 同时用于提示词生成和运行时编译，签名和校验不会互相漂移。

当前未传入示例回合（`A2uiGenerator` 第二个参数为 `undefined`）。快照约 51.7K 字符，脚本只打印字符数，未设上限。两项都列入第 10 节待办。

`xcard-generator` 的 SKILL.md 按交付形态分流：自由卡默认输出 `<a2ui>` 块并先读快照开头的 quick reference；工具 send/update 是高级路径；模板工具是可选稳定路径。SKILL.md 同时明确它是规则文档，不能当成 `dispatch_action` 的工具 id 调用。

### 3.3 Agent 如何知道要输出 `<a2ui>`

自动入口不是工具调用，不能只靠工具描述唤起。`buildMessageToolHints()` 追加几条短规则：

| 规则 | 内容 |
|---|---|
| FREEFORM | 用户要卡片时最终回复直接嵌入一个裸露 `<a2ui>` 块；前后可有普通文案，但 `<a2ui>` 本身不包 fence、不提 `.json/.jsonl` |
| EXPRESS QUICK SYNTAX | 块内是 Express 而不是 JSON；用数据赋值、`item = ...`、`root = Card(...)` 和 `List(_template(...))` 给模型一个正向骨架 |
| EXPRESS BOUNDS | `root` 必须存在；动态列表用相对绑定；`Text.variant` 只能用官方枚举 |
| EXPRESS FORBIDDEN | 禁止 JSONL 信封、自造 schema、数组下标、`List(items=...)`、`ListItem`、`Checkbox`、`style="title"` 和常见外部 UI 体系枚举 |
| TOOL OPTION | 需要等待、指定 mode/audience、更新已有卡或编译失败同轮重试时调工具，否则走 `<a2ui>` |
| TEMPLATE OPTION | 标准卡可用 `yuanbao_xcard_template`，自由业务卡仍走 `<a2ui>` |

hints 不含 catalog 签名，也不复制 `promptSnippet`。

官方编译结果的四项差异在归一化阶段统一改成第 2.2 节口径：`version: "1.0"`、`{ "@path" }` 绑定、单条带 `components` / `dataModel` 的 `createSurface`、SDK 带出的 catalogId。以仓库内 `skills/xcard-generator/references/specification/v1_0/` 和 `src/business/xcard/constants.ts` 为准，不以官方网页示例为准。

---

## 4. 目标架构

```text
工具 express / messages                  deliver payload（文本或结构化 part）
        │                                          │
        ▼                                          ▼
prepareGeneratedInput()                  extractA2uiReplyPart()
  generated-input.ts                       reply-part.ts
        │                                          │
        ├─ messages ─► parseGeneratedMessages()    │
        │              validateGeneratedMessages() │
        │                                          │
        └─ express ──────────────┬─────────────────┘
                                 ▼
                     compileExpressMessages()      express.ts
                       │ 只剥离外层 fence / <a2ui>
                       │ @a2ui/agent parseResponse()
                       │ normalizeExpressMessages()
                       │ validateGeneratedMessages()
                       ▼
            createGeneratedCard() / updateGeneratedCard()
                                 │
                                 ▼
                      现有 101 / 102 / 103 链路
```

新增模块：

| 文件 | 职责 |
|---|---|
| `scripts/generate-a2ui-agent-catalog.mjs` | 派生 agent catalog 和提示词快照；`--check` 比对漂移 |
| `src/business/xcard/agent-catalog.json` | 生成物，不手改 |
| `skills/xcard-generator/references/express-prompt.md` | 生成物，不手改 |
| `src/business/xcard/express.ts` | 加载 catalog、调用 SDK、归一化、校验，生成修正提示 |
| `src/business/xcard/generated-input.ts` | 工具入口共用：`express` / `messages` 二选一、编译或解析、校验、组装可重试错误 |
| `src/business/xcard/reply-part.ts` | 识别 a2ui reply part，判断流式前缀，发送或更新 generated 卡 |

工具层只做入参分发，不复制发送和更新实现。`<a2ui>` 入口直接调用 `compileExpressMessages()`（已含校验），再调用与工具相同的 `createGeneratedCard()` / `updateGeneratedCard()`。

---

## 5. 归一化契约

`normalizeExpressMessages(messages)` 输入 SDK 消息，输出 `A2uiMessage[]`；`compileExpressMessages()` 随后调用 `validateGeneratedMessages()`。

### 5.1 允许和拒绝的消息

允许：`createSurface`、`updateComponents`、`updateDataModel`。

拒绝：

| 输入 | 错误 |
|---|---|
| `deleteSurface` | `deleteSurface is not supported for Yuanbao xCard` |
| 其他消息体（如 `callRendererFunction`）或一条消息含多个消息体 | `A2UI message must contain exactly one supported body` |
| 多个 surfaceId | `Express output contains multiple surfaceIds` |
| 没有 `createSurface` | `Express output must create a surface` |

SDK 侧 `allowedMessages` 也只放这三种，两层都会拦。关闭卡片仍走工具的 close 语义或 `mode=once` 状态机。

### 5.2 输出形状

固定输出：

```json
[
  {
    "version": "v1.0",
    "createSurface": {
      "surfaceId": "<模型草稿 id，默认 main，稍后由插件重写>",
      "catalogId": "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json"
    }
  },
  { "version": "v1.0", "updateComponents": { "surfaceId": "<同上>", "components": [] } },
  { "version": "v1.0", "updateDataModel": { "surfaceId": "<同上>", "path": "/", "value": {} } }
]
```

规则：

1. 所有 `version` 写成 `"v1.0"`。
2. `catalogId` 写成 `XCARD_CATALOG_ID`，SDK 带出的 catalog id 不透传。
3. 组件按出现顺序合并：先 `createSurface.components`，再各条 `updateComponents`；同一 `id` 后出现的为准。
4. `createSurface.dataModel` 变成一条 `path: "/"` 的 `updateDataModel`；没有数据时 `value` 为 `{}`，保证 `/__openclaw` 投影有落点。
5. 其余 `updateDataModel` 排在根数据之后，path 和 value 原样保留，`surfaceId` 统一成草稿 id。
6. 输出的 `createSurface` 不带 `components` 和 `dataModel`。
7. 缺少 `root`、悬空子组件 id 由 `validateGeneratedMessages()` 拒绝，归一化不发明根节点。

`renderGeneratedMessages()` 继续重写全部 `surfaceId`、注入可信 extension、追加 `/__openclaw`。归一化不写 OpenClaw metadata，不生成最终 `surfaceId`。

### 5.3 绑定字段

只对组件做深度遍历（含 `action.event.context`、函数参数和全部组件属性）：

- 含 `"@path"` 时改名为 `"path"`。
- 同时含 `"path"` 和 `"@path"` 且值不同，归一化失败。

dataModel 和 `updateDataModel` 是业务数据，不是绑定，用 `structuredClone` 原样保留，业务里恰好叫 `@path` 的键不会被改写。

### 5.4 幂等

输入已经是三段式时，归一化不复制组件，不把 `updateDataModel` 再包进 `createSurface`。

---

## 6. 编译层

### 6.1 `compileExpressMessages(input)`

1. 空值或非字符串直接失败。
2. 预处理只剥离整段外层 Markdown fence 和 `<a2ui>` 包装，不改写 Express 正文、字符串字面量或业务数据。
3. 预处理后仍含 `<a2ui>` 标签时失败。
4. 进程级缓存一个 `A2uiGenerator`；每次编译新建 processor，能力声明固定为 `{ "1.0": { supportedCatalogIds: [XCARD_CATALOG_ID] } }`。不在会话间复用 `RendererState`，否则会和插件自己的 revision 冲突。
5. `parseResponse(source, { wrapped: false })`，取 `type === "a2ui"` 的消息；一条都没有时失败。
6. 归一化，再 `validateGeneratedMessages()`。
7. 所有失败返回 `{ error, errors }`。`errors` 由 `buildExpressRepairHints()` 生成，覆盖：缺 `root`、数组下标绑定、`List(items=...)`、`ListItem`、`Checkbox`、`style="title"`、自造 JSON schema、残留 `<a2ui>` / fence。不回传异常栈。

结构性错误只给提示、不自动改写。曾经尝试过按启发式重写列表（`repairIndexedList`），会整体替换 `root`、丢掉按钮和事件，已删除。

本通道没有客户端能力协商，不实现官方的多版本协商循环。

### 6.2 运行时加载

```ts
import { Catalog } from "@a2ui/web_core";
import agentCatalogJson from "./agent-catalog.json" with { type: "json" };

const generator = new A2uiGenerator(
  [new CatalogConfig(Catalog.fromJson(agentCatalogJson))],
  undefined,
  new ExpressFormatFactory({ allowedMessages: ["createSurface", "updateComponents", "updateDataModel"] }),
);
```

生成脚本加载同一份派生 catalog 构造 generator，模型看到的签名和运行时接受的组件、函数一致。运行时不再叠 transformer，也不现算派生。

`package.json` 的 `openclaw.bundle.stageRuntimeDependencies` 为 true，两个 `@a2ui/*` 包会进插件包。`resolveJsonModule` 让 tsc 把 catalog 复制到 `dist/src/business/xcard/agent-catalog.json`，已手工验证从 `dist` 加载并编译成功；自动化用例待补。

### 6.3 宿主 SDK 与版本下限

`openclaw` devDependency 锁定为 `2026.11.4`，SDK 子路径同步迁移：

| 旧 | 新 |
|---|---|
| `plugin-sdk/config-runtime` 的 `OpenClawConfig` | `plugin-sdk/config-contracts` |
| `plugin-sdk/command-auth` 的 `listChatCommandsForConfig` / `ChatCommandDefinition` | `plugin-sdk/command-auth-native` 的 `listChatCommands` / `ChatCommandDefinition`；插件按配置过滤 `config`、`mcp`、`plugins`、`debug`、`bash`，仅显式 `true` 时同步。命令名取首个 `textAliases`，不做 native provider 过滤，保留 `/openclaw`、`/allowlist`、`/login` |
| `plugin-sdk/command-auth` 的 `resolveControlCommandGate` | `plugin-sdk/command-auth-native` |
| `plugin-sdk/channel-reply-pipeline` 的 `createChannelReplyPipeline` | `plugin-sdk/channel-outbound` 的 `createChannelMessageReplyPipeline` |

逐版本核对 npm 发布包：`channel-outbound` 及其 `createChannelMessageReplyPipeline` 从 2026.5.27 起才有，2026.5.26 没有。`openclaw.install.minHostVersion` 因此从 `>=2026.5.7` 提到 `>=2026.5.27`；`infra/env.ts` 和升级预检都从这个字段读。

---

## 7. 入口接口

### 7.1 `yuanbao_xcard_send`

新增 `express?: string`：A2UI Express 正文，不含 `<a2ui>` 标签、Markdown fence 或说明文字。`messages` 保留。其余参数不变：`title`、`fallbackText`、`audience`、`mode`、`waitForAction`、`waitTimeoutSec`。

JSON Schema `required` 改为 `["title", "mode"]`，否则只传 `express` 的调用会在进入 `execute()` 前被宿主拒绝。内容入参由 `prepareGeneratedInput()` 校验：

| 输入 | 结果 |
|---|---|
| 两个都缺或都传 | 可重试错误「messages 和 express 必须且只能传一个」 |
| 只有 `messages` | JSONL 解析 + 校验，失败提示改 JSONL 或改用 `express` |
| 只有 `express` | `compileExpressMessages()`，失败返回 `errors` 和统一的重试说明（只改 `express` 重调，不把 DSL 或错误发给用户） |

### 7.2 `yuanbao_xcard_update`

同样增加 `express`，与 `messages` 互斥，`required` 改为 `["surfaceId"]`。更新仍提交完整快照，归一化结果含 `createSurface`；`updateGeneratedCard()` 保存完整快照，103 发送时去掉 `createSurface`。`mode`、`audience`、owner 和 session 绑定不能通过更新修改。

### 7.3 模型可见说明

工具描述只写工具语义，不抄签名表：

- 一次性自由卡默认走 `<a2ui>`；需要等待、指定 mode/audience/title、或正文块失败后重试时调本工具。
- 优先 `express`，只传正文；`messages` 仅用于已有 JSONL。
- 最小正确写法、动态列表写法、`variant` 取值和常见反例各一行。
- 结果态 `__openclaw`、`resultText`、`once` / `perRevision`、`audience` 规则沿用原描述。
- 同一业务后续变化走 update；发送成功后不复述卡片内容。

`xcard-design` 只管视觉决策，交付口径与 `xcard-generator` 一致。

### 7.4 `<a2ui>` 自动入口

**识别**（`extractA2uiReplyPart`）：

1. 结构化 part：`type` / `kind` / `messageType` 为 `a2ui` 或 `a2ui-express`，或带 `a2ui` / `a2uiContent` 字段；也遍历 `parts` / `content` / `messages` / `items`。
2. 文本：提取显式闭合的裸露 `<a2ui>...</a2ui>` 块；前后内容分别保存在 `textBefore` / `textAfter`，不丢弃宿主回复前缀或说明文字。外层 Markdown fence 只作为旧上下文/低质量模型输出的容错输入，不是生成契约。

**非 streaming 发送**：将前文 `TIMTextElem`、卡片 `TIMCustomElem`、后文 `TIMTextElem` 按顺序放入同一个 `msg_body`，只调用一次群聊或私聊发送接口。前后文仍是普通 IM 文本，不塞进 A2UI 组件，不按 Markdown chunk 拆消息，空白元素省略。卡片更新也把正文与 103 信封放进同一次请求。

**失败与大小**：编译或发送失败时，将前文、卡片降级文案、后文合成一条文本消息。服务端拒绝卡片后只发一次合并 fallback，已发出的 fallback 不再重复发送。10KB 预算计入全部自定义 data 和前后文本的 UTF-8 字节，超限失败，不拆消息。识别到卡片后清空本 segment 的已缓冲 partial，避免 `finalize()` 再发送包含 DSL 的全文。

没有闭合标签或仅有不含 `<a2ui>` 的代码块时，仍按普通文本发送。模型提示要求裸露嵌入一个 `<a2ui>` 块，但解析不要求前后为空。

**streaming 不在本次修改和验收范围内**。保留既有 `mayBecomeA2uiReply` / `a2uiHeld` 逻辑；宿主 block 分块时的卡片重组不在本期处理。

**控制信息**：

| 字段 | 取值 |
|---|---|
| `title` / `fallbackText` | 优先结构化 part 的 metadata；否则「交互卡片」 |
| `mode` | metadata 明确 `perRevision` 才用，否则 `once` |
| `audience` | 群聊且 metadata 明确 `anyone` 才放开，否则 `requester` |
| `waitForAction` | 不支持，需要等待走工具 |
| 更新 | 仅当 metadata 给出 `surfaceId`，且对应卡片是本账号、本会话、本 sessionKey、状态 active 的 generated 卡时走 103；否则失败，不猜测目标 |

**失败**：编译、校验或发送失败时记 warn 日志，给用户发「卡片生成失败，请稍后重试。」，不暴露内部工具名。拿不到会话目标时同样处理。`XCardSendError.fallbackSent` 为真（已降级成文字发出）视为成功。

**覆盖范围**：只有 `dispatch-reply` 的 `deliver` 路径会拦截 `<a2ui>`。cron、subagent 和主动 messaging 的回复走 `actions/text/send.ts`，不经过这里。当前没有主动发送场景，暂不加出站兜底；接入主动发送前需先补，见第 12 节。

---

## 8. 安全边界

归一化之后仍然调用 `validateGeneratedMessages()`。SDK 校验通过不等于可以发送。

继续拒绝：

- `WebCard`、`xCardTemplate`
- `tracking`
- `@hostEnv`
- 未登记函数
- `callAgentFunction`、`agentFunctionResponse`
- 非 xcard catalog
- 非 `"v1.0"`
- 缺少 `root`、悬空子组件 id
- 超过 10KB 的编译后线包

事件名仍然从归一化后的组件树提取。客户端 102 里未声明的 action 继续由 `events.ts` 拒绝。

Express 缩短的是模型 token。10KB 限制看编译后的自定义 JSON 与同消息前后文本的总字节，不看 Express 原文。官方编译会生成 `root_child_children_0` 这类 id，线包可能比手写 JSONL 更大；超限仍返回 `too_large`，不会拆成多条消息。

日志只记长度和计数，不记 Express 原文、用户内容和 `sessionKey`。ESLint 开启 `no-debugger: error`。

---

## 9. 不改的部分

| 模块 | 原因 |
|---|---|
| `transport-im1007.ts` | Express 不改变 101/102/103 |
| `events.ts` | 入站事件已经是规范化后的 action |
| `registry.ts` | Surface 身份、revision、audience 与产出语法无关 |
| `service.ts` 的限流、注册和 103 裁剪 | 保留原策略；发送层增加同消息前后文本合并、整体大小校验与合并 fallback |
| `templates/` | 模板卡不由模型写 Express |
| `channel.ts` | 只引用 `buildMessageToolHints()`，不注入 catalog prompt |

---

## 10. 实施状态

| 项 | 状态 |
|---|---|
| 依赖与 catalog 派生、`--check` | 已完成 |
| 归一化与编译、修正提示 | 已完成 |
| 工具 `express` 参数与 `generated-input.ts` 共用逻辑 | 已完成 |
| `<a2ui>` 自动入口（非 streaming 前文、卡片、后文单消息发送；失败单条降级） | 单测已完成；混合布局待客户端联调；streaming 不在本期验收范围 |
| update 走 Express 全量快照 | 已完成（工具路径；自动入口需 metadata 给出 `surfaceId`） |
| 提示词三处口径统一 | 已完成 |
| SDK 子路径迁移、`minHostVersion` | 已完成 |
| `--check` 接入 CI | 待办 |
| 提示词快照字符上限、示例回合 | 待办。当前约 51.7K 字符、无示例 |
| 函数 schema 转官方 `args` 形状 | 待办，SDK 当前可用，非阻塞 |
| 从 `dist` 加载 agent catalog | 手工已验证，自动化用例待补 |
| 非 dispatch-reply 出站路径（cron / 主动 messaging）的 `<a2ui>` 兜底 | 暂不处理，当前无主动发送场景；见第 12 节 |
| 宿主若原生输出结构化 a2ui part，记录真实字段名并补用例 | 待观察 |

---

## 11. 测试

最小 Express 样例（已验证能编译并通过校验）：

```text
$/flight/number = "NH 105"
root = Card(Column(children=[
  Text($/flight/number),
  Button(Text("值机"), action=Event("check_in", {flight: $/flight/number, resultText: "已值机 NH 105"}))
]))
```

已覆盖：

| 用例 | 文件 |
|---|---|
| 编译 + 归一化通过校验；版本、catalog、`path` 绑定、消息拆分 | `xcard/express.test.ts` |
| 外层 fence / `<a2ui>` 包装可剥离 | `xcard/express.test.ts` |
| `_template` 列表能编译 | `xcard/express.test.ts` |
| 数组下标、`List(items=...)`、`ListItem`、`Checkbox` 返回提示，不自动改写 | `xcard/express.test.ts` |
| `style` 返回 `variant` 修正提示；字符串和业务数据中的 `style=` 原样保留 | `xcard/express.test.ts` |
| dataModel 中的 `@path` 键原样保留 | `xcard/express.test.ts` |
| 结构化 part、`<a2ui>`、外层 fence 识别，前后文本独立提取 | `xcard/reply-part.test.ts` |
| 非 streaming 不单独发前后文、失败单条降级、已缓冲 partial 不重复发送 | `pipeline/middlewares/dispatch-reply.test.ts` |
| 前文→卡片→后文同一 `msg_body`、群聊/私聊各一次请求、单边和空白文本、拒绝后合并 fallback、整体大小限制、带正文的 103 更新 | `xcard/reply-part.test.ts` |
| 完整文本命令清单、配置命令开关 | `commands/command-sync/index.test.ts` |
| `mayBecomeA2uiReply` 正反例 | `xcard/reply-part.test.ts` |
| 未闭合 partial 不泄漏；疑似前缀最终不是卡片时由 `deliver` 补发 | `pipeline/middlewares/dispatch-reply.test.ts` |
| send / update 参数互斥、`required`、Express 失败可重试并带提示 | `tools/xcard-send.test.ts`、`tools/xcard-update.test.ts` |
| template 工具群聊和私聊均暴露 | `tools/xcard.test.ts` |
| hints 含各条 xCard 规则 | `messaging/targets.test.ts` |
| 生成物漂移 | `pnpm xcard:agent-catalog:check` |

待补：

| 用例 | 期望 |
|---|---|
| Express 成功发送 | 101 `content` 为三段基底 + `/__openclaw`；`extractGeneratedActions()` 含 `check_in`，102 被接受 |
| once 关闭 | 103 中 `root.enabled === false`、`/__openclaw.completed === true` |
| Express update | 103 不含 `createSurface`，含新组件树 |
| `sendA2uiReplyPart` 归属校验 | `surfaceId` 跨会话或状态不符时拒绝 |
| 客户端混合布局联调 | 验证同消息 text/custom/text 被服务端保留并按顺序展示；目前单测仅验证一次请求及其 body |
| 禁用组件、超限 | `WebCard` / `@hostEnv` 校验失败；超过 10KB 返回 `too_large`，不发 IM |
| `dist` 加载 | 构建产物下 agent catalog 可加载 |

---

## 12. 风险

| 风险 | 处理 |
|---|---|
| 派生 catalog 与 canonical 漂移 | 生成物不手改，`--check` 逐字比较；待接入 CI |
| 提示词快照偏大（约 51.7K 字符） | 后续设上限，先收紧裁剪名单再考虑补示例 |
| `<a2ui>` 正文块不能同轮自纠错，弱模型失败率高 | 提示词限定简单卡走正文块；复杂、需重试或需等待的走工具；失败时给用户短文案 |
| hints 是通道级注入，但只有 dispatch-reply 会拦截 `<a2ui>`。cron / subagent / 主动 messaging 的回复走 `actions/text/send.ts`，模型若在这些路径输出正文块，用户会看到原始 DSL | 已知，暂不处理：当前没有主动发送场景。接入前先在 `actions/text/send.ts` 加出站兜底（整段是 `<a2ui>` 时不发原文），或让 `messageToolHints()` 按会话作用域注入，使 cron / subagent 不下发该规则 |
| 普通回答讲解显式闭合的 `<a2ui>` 块 | 当前显式标签即卡片入口，不区分示例意图；前后说明保留为文本发送，不含标签的代码块不触发 |
| 宿主将来原生解析 `<a2ui>`，字段名不同 | 结构化识别已兼容多种字段名；出现后记录真实结构并补用例 |
| SDK 输出形状随版本变化 | 编译测试用真实 `parseResponse()`；依赖用 `^` 范围，升级时跑全量单测 |
| 编译后线包变大 | 继续按 10KB 拒绝，提示缩短文案和列表 |
| 模型混用 JSONL 和 Express | 参数互斥，错误信息指出该用哪一个 |
| 旧宿主缺少新 SDK 子路径 | `minHostVersion >=2026.5.27`，启动和升级预检拦截 |

---

## 13. 验收

同时满足下面四条才算接入完成：

1. 模型能通过 `<a2ui>` 正文块或工具 `express` 提交 Express；插件发出的 101 是归一化三段基底加 `/__openclaw` 投影，符合现有 A2UI v1.0 xCard 线包口径。
2. 用户点击 Express 卡片声明的事件后，102 能被接受，once 卡片能关闭。
3. 对同一 `surfaceId` 提交新的 Express 全量快照时，103 更新组件树和数据。
4. 原 JSONL send / update 用例不回退。

第 1 条的单测已覆盖编译和识别，第 2、3 条依赖第 11 节的待补用例或端到端验证。
