# 死代码 / 废弃代码记录

> 补单测过程中发现的疑似死代码 / 废弃代码。**不为这些代码补测**，待后续统一评估能否删除。
> 格式：`文件:行` — 说明 — 发现时间 / 阶段。

| 文件:行 | 说明 | 发现于 |
|---|---|---|
| `src/infra/env.ts:33-43` `getMinHostVersion` | 非死代码，但**路径脆弱**：`createRequire('../../../package.json')` 按 `dist/` 布局写死，src/tsx 下解析不到 → 运行时兼容性守卫 `assertHostVersionCompatible` 静默失效（仅 dist 构建产物生效）。建议后续改为更稳健的版本来源或显式构建期注入。 | Phase 1 / T1.5 |
| `src/business/pipeline/middlewares/guard-send-access.ts` allowlist 分支 | **不可达**：`DEFAULT_SEND_ACCESS_POLICY` 写死，`allowlist` policy 永远走不到 → 对应分支无法被测。要么暴露策略配置、要么删除 allowlist 分支。 | Phase 2 |
| `src/access/ws/client.ts` 心跳连续超时重连 | **潜在 bug**：ping 响应 handler 未重新调度下一次超时检测，连续超时累计逻辑会漏判 → 弱网下可能不触发预期的重连。需修复后补回归测试。 | Phase 2 |
