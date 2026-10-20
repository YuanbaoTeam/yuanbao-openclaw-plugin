/**
 * Unit tests for accounts.ts — config resolution defaults, token "key:secret"
 * auto-parse, overflow/replyTo normalization, and the configured/enabled flags.
 * Uses real SDK account helpers with plain config objects (no mocks).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { listEnabledYuanbaoAccounts, resolveYuanbaoAccount } from "./accounts.js";

function cfg(yuanbao: Record<string, unknown> | undefined): OpenClawConfig {
  return { channels: yuanbao ? { yuanbao } : {} } as unknown as OpenClawConfig;
}

void test("resolveYuanbaoAccount applies defaults when no yuanbao config", () => {
  const acc = resolveYuanbaoAccount({ cfg: cfg(undefined) });
  assert.equal(acc.configured, false);
  assert.equal(acc.apiDomain, "bot.yuanbao.tencent.com");
  assert.equal(acc.overflowPolicy, "split");
  assert.equal(acc.replyToMode, "first");
  assert.equal(acc.mediaMaxMb, 20);
  assert.equal(acc.historyLimit, 100);
  assert.equal(acc.requireMention, true);
  assert.equal(acc.disableBlockStreaming, false);
  assert.equal(acc.markdownHintEnabled, true);
  assert.equal(acc.fallbackReply, "暂时无法解答，你可以换个问题问问我哦");
});

void test("resolveYuanbaoAccount marks configured when appKey + appSecret present", () => {
  const acc = resolveYuanbaoAccount({ cfg: cfg({ appKey: " k ", appSecret: " s " }) });
  assert.equal(acc.configured, true);
  assert.equal(acc.appKey, "k"); // trimmed
  assert.equal(acc.appSecret, "s");
});

void test("token 'appKey:appSecret' auto-parses and clears token", () => {
  const acc = resolveYuanbaoAccount({ cfg: cfg({ token: "myKey:mySecret" }) });
  assert.equal(acc.appKey, "myKey");
  assert.equal(acc.appSecret, "mySecret");
  assert.equal(acc.configured, true);
  assert.equal("token" in acc, false, "token must be cleared after parsing");
});

void test("explicit pre-signed token (no colon) is preserved", () => {
  const acc = resolveYuanbaoAccount({ cfg: cfg({ appKey: "k", appSecret: "s", token: "presigned" }) });
  assert.equal(acc.token, "presigned");
});

void test("overflowPolicy and replyToMode normalize unknown values", () => {
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ overflowPolicy: "stop" }) }).overflowPolicy, "stop");
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ overflowPolicy: "weird" }) }).overflowPolicy, "split");
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ replyToMode: "off" }) }).replyToMode, "off");
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ replyToMode: "all" }) }).replyToMode, "all");
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ replyToMode: "nonsense" }) }).replyToMode, "first");
});

void test("custom numeric/boolean fields are respected", () => {
  const acc = resolveYuanbaoAccount({
    cfg: cfg({ appKey: "k", appSecret: "s", mediaMaxMb: 50, historyLimit: 0, requireMention: false, disableBlockStreaming: true, markdownHintEnabled: false }),
  });
  assert.equal(acc.mediaMaxMb, 50);
  assert.equal(acc.historyLimit, 0);
  assert.equal(acc.requireMention, false);
  assert.equal(acc.disableBlockStreaming, true);
  assert.equal(acc.markdownHintEnabled, false);
});

void test("mediaMaxMb below 1 falls back to default 20", () => {
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ mediaMaxMb: 0 }) }).mediaMaxMb, 20);
});

void test("top-level enabled:false disables the account", () => {
  assert.equal(resolveYuanbaoAccount({ cfg: cfg({ enabled: false, appKey: "k", appSecret: "s" }) }).enabled, false);
});

void test("listEnabledYuanbaoAccounts filters disabled sub-accounts", () => {
  const config = cfg({
    appKey: "k", appSecret: "s",
    accounts: {
      main: { name: "main" },
      off: { name: "off", enabled: false },
    },
  });
  const enabled = listEnabledYuanbaoAccounts(config);
  assert.ok(Array.isArray(enabled));
  assert.ok(enabled.every(a => a.enabled));
});
