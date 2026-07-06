# OpenClaw × 元宝 新人上手指南

本文覆盖从零到"能在元宝里 @机器人对话"的完整流程，也包含开发本仓库（`yuanbao-openclaw-plugin`）时的本地联调步骤。

> **适用版本**：openclaw CLI `2026.6.11`，本插件 `2.17.0`，Node 22.x
> **平台**：macOS（Linux 同理，路径请自行替换）

---

## 0. 你会得到什么

- 一台本机跑着 **OpenClaw Gateway**（`ws://127.0.0.1:18789`）
- Gateway 通过本仓库插件连上**元宝 App 里的机器人**
- Gateway 通过**硅基流动（SiliconFlow）**调用 DeepSeek-V3 生成回复
- 元宝里 @机器人 → 插件把消息投递给 Gateway → Agent 调 LLM → 回复送回元宝

链路一句话总结：**元宝 App ⇄ yuanbao-openclaw-plugin ⇄ OpenClaw Gateway ⇄ SiliconFlow (DeepSeek-V3)**

---

## 1. 前置准备

| 项 | 说明 |
| --- | --- |
| Node | ≥ 22.19（LTS）或 24；推荐直接 `brew install node` |
| 元宝 App | 已登录，能进入"元宝派"入口 |
| SiliconFlow Key | 到 https://cloud.siliconflow.cn/account/ak 生成，形如 `sk-xxxxxxxx` |
| （可选）本仓库 | `git clone` 本仓库并 `pnpm install && pnpm build`，若你要改插件源码 |

---

## 2. 安装 OpenClaw CLI

```bash
npm i -g openclaw
openclaw --version   # 2026.6.11 或以上
```

初始化本地配置（会创建 `~/.openclaw/`）：

```bash
openclaw init
```

---

## 3. 获取元宝机器人的 appKey / appSecret

在元宝 App 里操作，**不是**在 openclaw 里。

1. 打开元宝 App → 进入 **元宝派**
2. 顶部弹窗"**元宝派支持养虾啦！**"里选择：
   - **方式 1（一键脚本）**：点"复制"，把 `bash <(curl -fsSL https://static.yua...)` 粘到终端执行，一步到位（脚本会自动装 CLI + 配 channel）
   - **方式 2（手动配置，推荐给开发者）**：复制下方的 `AppID`（即 appKey） 和 `AppSecret`
3. 复制到手后，去下一步配 channel

> 截图里那个入口叫 "**关联已有 OpenClaw**"，方式 2 下面就是 `AppID` + `AppSecret` 两栏。

---

## 4. 把元宝 channel 配到 OpenClaw

```bash
openclaw channels add \
  --channel yuanbao \
  --token "<你的AppID>:<你的AppSecret>"
```

验证：

```bash
openclaw channels list
# 期望看到：Yuanbao default: installed, configured, enabled
```

配完等价于在 `~/.openclaw/openclaw.json` 里写了：

```json
{
  "channels": {
    "yuanbao": {
      "dm": { "policy": "open", "allowFrom": ["*"] },
      "appKey": "<你的AppID>",
      "appSecret": "<你的AppSecret>",
      "enabled": true
    }
  }
}
```

---

## 5. 装并启动 Gateway

```bash
openclaw gateway install     # 注册为 macOS LaunchAgent
openclaw gateway restart     # 启动
openclaw gateway status      # 查看
```

正常输出关键字段：

```
Runtime: running (pid xxxxx)
Listening: 127.0.0.1:18789, [::1]:18789
Connectivity probe: ok
Capability: connected-no-operator-scope   ← 见 §7 说明
Dashboard: http://127.0.0.1:18789/
```

打开 <http://127.0.0.1:18789/> 就是 Dashboard，能直接跟 Bot 对话。

---

## 6. 配置 LLM Provider（硅基流动 / SiliconFlow）

Gateway 起来后如果直接对话，会报：

```
Agent failed before reply: No API key found for provider "openai" ... missing-provider-auth.
```

原因：openclaw 默认走 `openai/gpt-5.5`，但你没配 OpenAI Key。我们用**硅基流动 + DeepSeek-V3** 替代。

### 6.1 编辑 `~/.openclaw/openclaw.json`

在 root object 里追加 `models` 和 `agents` 两段：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "siliconflow": {
        "baseUrl": "https://api.siliconflow.cn/v1",
        "apiKey": "sk-你的硅基Key",
        "api": "openai-completions",
        "models": [
          { "id": "deepseek-ai/DeepSeek-V3", "name": "DeepSeek V3 (SiliconFlow)" },
          { "id": "Qwen/Qwen2.5-72B-Instruct", "name": "Qwen2.5 72B Instruct (SiliconFlow)" },
          { "id": "Qwen/Qwen2.5-Coder-32B-Instruct", "name": "Qwen2.5 Coder 32B (SiliconFlow)" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "siliconflow/deepseek-ai/DeepSeek-V3" }
    }
  }
}
```

**关键字段的坑（今天踩过的）**：

| 字段 | 值 | 备注 |
| --- | --- | --- |
| `api` | `openai-completions` | ❌ **不是** `openai-chat`，会被 schema 拒。合法值：`openai-completions`、`openai-responses`、`openai-chatgpt-responses`、`anthropic-messages`、`google-generative-ai`、`google-vertex`、`github-copilot`、`bedrock-converse-stream`、`ollama`、`azure-openai-responses` |
| `baseUrl` | `https://api.siliconflow.cn/v1` | 硅基官方 OpenAI 兼容端点 |
| `primary` | `siliconflow/deepseek-ai/DeepSeek-V3` | 拼法是 `<provider>/<model_id>`，硅基的 model_id 本身带斜杠属正常 |
| `mode` | `merge` | 与内置 catalog 合并；用 `replace` 会覆盖全部 |

### 6.2 校验 + 重启

```bash
openclaw config validate     # 期望：Config valid
openclaw gateway restart
openclaw models status       # 期望：默认模型指向 siliconflow/deepseek-ai/DeepSeek-V3
```

如果校验失败，openclaw 会告诉你哪个字段不合法（和 `~/.openclaw/openclaw.json.bak` 一起对比修）。

### 6.3 类比：其他 provider 怎么写

同一格式还能挂别的 OpenAI/Anthropic 兼容后端，例如 MiniMax（Anthropic 协议）：

```json
"minimax": {
  "baseUrl": "https://api.minimaxi.com/anthropic",
  "apiKey": "sk-cp-xxxxxx",
  "api": "anthropic-messages",
  "models": [{ "id": "MiniMax-M2.5", "name": "MiniMax M2.5" }]
}
```

只要选对 `api` 字段值，走 openai 兼容协议就用 `openai-completions`，走 anthropic 就用 `anthropic-messages`。

---

## 7. 进入元宝 App 里 @ 机器人试对话

1. 元宝 App 里，把机器人加进某个群 or 私聊
2. @ 机器人 或直接发消息
3. 一切正常的话，几秒内会收到回复

### `Capability: connected-no-operator-scope` 是什么？

看到 `openclaw gateway status` 里这行**不是错误**，意思是：Gateway 已经连上元宝，但当前 App Key 还没被授权任何"可服务对象"（用户/群/权限范围）。要真正收到消息，需要在元宝机器人后台把服务对象加进 allowlist 或者把机器人拉进要服务的群。

---

## 8. 常见问题速查

### 8.1 `No API key found for provider "openai"`

**根因**：默认模型是 openai 系但没配 Key。**修复**：见 §6，改成硅基/其他 provider。

### 8.2 `models.providers.xxx.api: Invalid input`

**根因**：`api` 字段写错。**修复**：查 §6.1 合法值表，硅基/DeepSeek/Qwen 都填 `openai-completions`。

### 8.3 `reply session initialization conflicted for agent:main:dashboard:xxx`

**根因**：同一个 dashboard/webchat session 上一轮 reply 还在初始化中，第二条消息又进来，抢同一个 `sessionKey` 造成冲突。常发生于：
- 上一轮流式还没走完就发第二条
- Dashboard 页面刷新/切标签导致前一次 reply 没干净结束
- Gateway 被重启但客户端还持有旧 session id

**修复（从轻到重）**：

```bash
# 1) 重启 gateway 释放 in-memory session 锁（保留历史）
openclaw gateway restart

# 2) 仍复现，看是哪种 channel 出的问题
openclaw logs --limit 200 --plain | grep -iE "conflict|sessionKey|channel="

# 3) 实在不行清 session 索引（会丢历史对话）
openclaw gateway stop
rm ~/.openclaw/agents/main/sessions/sessions.json
openclaw gateway start
```

从今天的日志看 `channel=webchat`（Dashboard）比 `channel=yuanbao` 更容易触发这个 bug，元宝入口稳定得多。

### 8.4 `System Node 22 LTS (22.19+) or Node 24 not found`

**根因**：openclaw 更希望走"系统 Node"而不是 nvm 的 Node，仅推荐、不影响功能。**修复（可选）**：`brew install node`，然后 `openclaw doctor --repair`。

### 8.5 想清空一切重来

```bash
openclaw gateway stop
openclaw reset            # 清 config/state，保留 CLI
openclaw init             # 重新走一次
```

---

## 9. 本地开发本插件（可选）

如果你要改本仓库源码（`~/coding/yuanbao-openclaw-plugin`）：

```bash
pnpm install
pnpm build                # 产出 dist/

# 把本地插件 link 到 openclaw
openclaw plugins add --link /Users/tongxue/coding/yuanbao-openclaw-plugin

# 或者手动在 ~/.openclaw/openclaw.json 里配（等价）
# {
#   "plugins": {
#     "load": { "paths": ["/Users/tongxue/coding/yuanbao-openclaw-plugin"] },
#     "entries": { "openclaw-plugin-yuanbao": { "enabled": true } }
#   }
# }

openclaw gateway restart
openclaw plugins list | grep yuanbao       # 应看到本地路径且 enabled
openclaw logs --follow                     # 监听插件日志
```

改完 TS 源码 → `pnpm build` → `openclaw gateway restart` 生效。

---

## 10. 一份跑通后的 `~/.openclaw/openclaw.json` 参考

```json
{
  "plugins": {
    "load": { "paths": ["/Users/tongxue/coding/yuanbao-openclaw-plugin"] },
    "entries": { "openclaw-plugin-yuanbao": { "enabled": true } }
  },
  "channels": {
    "yuanbao": {
      "dm": { "policy": "open", "allowFrom": ["*"] },
      "appKey": "<你的AppID>",
      "appSecret": "<你的AppSecret>",
      "enabled": true
    }
  },
  "gateway": {
    "mode": "local",
    "auth": { "mode": "token", "token": "<自动生成>" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "siliconflow": {
        "baseUrl": "https://api.siliconflow.cn/v1",
        "apiKey": "sk-你的硅基Key",
        "api": "openai-completions",
        "models": [
          { "id": "deepseek-ai/DeepSeek-V3", "name": "DeepSeek V3 (SiliconFlow)" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "siliconflow/deepseek-ai/DeepSeek-V3" }
    }
  }
}
```

---

## 11. 常用命令速查

```bash
# Gateway
openclaw gateway install|restart|stop|status

# 配置
openclaw config validate
openclaw doctor --fix

# Channel
openclaw channels list
openclaw channels add --channel yuanbao --token "<appKey>:<appSecret>"

# 模型 / Provider
openclaw models list
openclaw models status
openclaw models auth paste-api-key --provider <id>

# 插件
openclaw plugins list
openclaw plugins add --link <本地路径>

# 会话 / 日志
openclaw sessions list
openclaw logs --limit 200 --plain
openclaw logs --follow
```

---

配好之后回到元宝 App @ 你的机器人，看它是否回话。第一次会稍慢（DeepSeek-V3 首字节 2~5s 正常），之后就顺畅了。祝玩得开心 🦐（元宝派的养虾梗）。
