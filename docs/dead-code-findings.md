# 死代码 / 废弃代码记录

> 补单测过程中发现的疑似死代码 / 废弃代码。**不为这些代码补测**，待后续统一评估能否删除。
> 格式：`文件:行` — 说明 — 发现时间 / 阶段。

| 文件:行 | 说明 | 发现于 |
|---|---|---|
| `src/infra/env.ts:33-43` `getMinHostVersion` | 非死代码，但**路径脆弱**：`createRequire('../../../package.json')` 按 `dist/` 布局写死，src/tsx 下解析不到 → 运行时兼容性守卫 `assertHostVersionCompatible` 静默失效（仅 dist 构建产物生效）。建议后续改为更稳健的版本来源或显式构建期注入。 | Phase 1 / T1.5 |
| `src/business/pipeline/middlewares/guard-send-access.ts` allowlist 分支 | **不可达**：`DEFAULT_SEND_ACCESS_POLICY` 写死，`allowlist` policy 永远走不到 → 对应分支无法被测。要么暴露策略配置、要么删除 allowlist 分支。 | Phase 2 |
| `src/access/ws/client.ts` 心跳连续超时重连 | **已确认并修复**：发出 ping 后未调度 ACK 超时检查，导致服务端不回 PingRsp 时 timer 链断开、连续超时重连不触发。已在 `client.test.ts` 增加回归测试并在 `sendPing()` 发出 ping 后安排下一次 timeout check。 | Phase 2 / P0 |
