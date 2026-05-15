/** Scheduled reminder tool (yuanbao_remind). */

/**
 * Three-tier execution chain, attempted top-down:
 * 1. Gateway API (agent-harness-runtime available): calls cron API directly, status="ok"
 * 2. CLI (plugin-sdk/matrix available): runs `openclaw cron` command, status="ok"; falls back to tier 3 on failure
 * 3. Legacy fallback: returns status="PENDING_CRON_CALL" with cronToolParams to guide the model
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { type OpenClawPluginToolContext, json } from "../utils/utils.js";

interface RemindParams {
  action: 'add' | 'list' | 'remove';
  /** Semantic mode: remind=send a reminder, task=execute a task; defaults to remind */
  intent?: 'remind' | 'task';
  /** Task content (required when action=add) */
  content?: string;
  /**
   * Time specification (required when action=add).
   * - One-time: 5m / 1h30m / 2d
   * - Recurring: cron expression, e.g. 0 8 * * *
   */
  time?: string;
  /** Timezone for recurring (cron) jobs; defaults to Asia/Shanghai */
  timezone?: string;
  /** Job name (optional) */
  name?: string;
  /** Required when action=remove */
  jobId?: string;
}

// ============================================================================
// Dynamic capability detection
// ============================================================================

type GatewayToolCaller = (
  toolName: string,
  opts: { timeoutMs: number },
  params: Record<string, unknown>,
) => Promise<unknown>;

type PluginCommandRunner = (opts: {
  argv: string[];
  timeoutMs: number;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

let _callGatewayTool: GatewayToolCaller | null | undefined;
let _runPluginCmd: PluginCommandRunner | null | undefined;

async function resolveCallGatewayTool(): Promise<GatewayToolCaller | null> {
  if (_callGatewayTool !== undefined) return _callGatewayTool;
  try {
    const sdkPath = 'openclaw/plugin-sdk/agent-harness-runtime';
    const mod = await import(sdkPath);
    _callGatewayTool = mod.callGatewayTool as GatewayToolCaller;
  } catch {
    _callGatewayTool = null;
  }
  return _callGatewayTool;
}

async function resolveRunPluginCommand(): Promise<PluginCommandRunner | null> {
  if (_runPluginCmd !== undefined) return _runPluginCmd;
  try {
    const sdkPath = 'openclaw/plugin-sdk/matrix';
    const mod = await import(sdkPath);
    _runPluginCmd = mod.runPluginCommandWithTimeout as PluginCommandRunner;
  } catch {
    _runPluginCmd = null;
  }
  return _runPluginCmd;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_CLI_TIMEOUT_MS = 60_000;

const RemindSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'remove'],
      description:
        '操作类型: add=创建定时任务, list=查询已有任务, remove=删除任务。'
        + '删除前请先通过 list 获取 jobId。',
    },
    intent: {
      type: 'string',
      enum: ['remind', 'task'],
      description:
        '语义类型，决定触发后的行为模式。'
        + 'remind: 只需要提醒用户去做某事（如"休息一下""开会"）; '
        + 'task: 需要 AI 实际执行并输出结果（如"查询今日新闻""检查服务状态"）。'
        + '判断标准: 用户期望 AI 动手做事选 task，只需要一句提醒选 remind。',
    },
    content: {
      type: 'string',
      description:
        '任务需求的详细内容。action=add 时必填。'
        + '例如: "提醒用户休息一下"、"查询今日新闻"、"检查服务状态"。',
    },
    time: {
      type: 'string',
      description:
        '时间描述, action=add 时必填。'
        + '绝对时间: ISO 8601 UTC 格式, 如 "2026-04-29T14:00:00.000Z"(一次性任务); '
        + '相对时间: 5m、1h、1h30m、2d(一次性任务); '
        + 'cron 表达式: "0 8 * * *"、"0 9 * * 1-5"(循环任务)。',
    },
    name: {
      type: 'string',
      description:
        '任务名称(20字以内)，action=add 时可基于 content 内容生成，便于后续 list/remove 管理。',
    },
    jobId: {
      type: 'string',
      description:
        '任务 ID。仅 action=remove 时必填, 需先通过 action=list 获取。',
    },
  },
  required: ['action'],
} as const;

/** task mode: execute scheduled task, no reply length limit */
const TASK_AGENT_PROMPT_TEMPLATE = (content: string) => `你是一个任务执行助手。请在当前时刻完成以下任务：${content}。\n\n`
  + '## 要求\n'
  + '- 不要回复 HEARTBEAT_OK\n'
  + '- 不要解释你是谁\n'
  + '- 直接执行任务并输出可直接给用户的结果\n'
  + '- **禁止**调用 yuanbao_remind 或 cron 工具，**禁止**新建任何定时任务\n';

/** remind mode: warm reminder, keep reply brief */
const REMIND_AGENT_PROMPT_TEMPLATE = (content: string) => `你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${content}。\n\n`
  + '## 要求\n'
  + '- 不要回复 HEARTBEAT_OK\n'
  + '- 不要解释你是谁\n'
  + '- 直接输出一条暖心的提醒消息，不要携带其他和该提醒无关的内容\n'
  + '- 可以加一句简短的关怀话语\n'
  + '- 控制在 2-3 句话以内\n'
  + '- **禁止**调用 yuanbao_remind 或 cron 工具，**禁止**新建任何定时任务\n';

const TOOL_DESCRIPTION = [
  '创建/查询/删除元宝定时任务。当用户提出提醒、闹钟、定时、X分钟/小时后、每天/每周/每月/每年X点等需求时，必须调用本工具。',
  '重要：调用后必须检查返回结果中的 status 字段判断操作是否完成。',
  'status="ok" 表示已完成，可以告知用户；status="PENDING_CRON_CALL" 表示还需要调用 cron 工具才能生效。',
  '禁止在 status 不是 "ok" 时告知用户任务已设置成功。',
].join('\n');

// Legacy fallback: imperative instructions guiding the model to call cron (concise, non-ignorable)

const LEGACY_ADD_NEXT_STEP = '你必须立即调用 cron 工具，将 cronToolParams 中的参数传入。只有 cron 返回成功后才能告知用户。未调用 cron 之前，禁止回复"已设置"或"已创建"。';

const LEGACY_LIST_NEXT_STEP = '你必须立即调用 cron 工具执行 list，获取全量任务后按 filter.to 过滤，只返回当前会话的任务。禁止在调用 cron 之前回复任务列表。';

const LEGACY_REMOVE_NEXT_STEP = '你必须立即调用 cron 工具执行 remove，传入 cronToolParams.jobId。只有 cron 返回成功后才能告知用户已删除。';

// ============================================================================
// Time parsing & formatting
// ============================================================================

function parseRelativeTime(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    return parseInt(s, 10) * 60_000;
  }

  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(s)) !== null) {
    matched = true;
    const value = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'd': totalMs += value * 86_400_000; break;
      case 'h': totalMs += value * 3_600_000; break;
      case 'm': totalMs += value * 60_000; break;
      case 's': totalMs += value * 1_000; break;
      default: break;
    }
  }

  return matched ? Math.round(totalMs) : null;
}

/** Parses an ISO 8601 absolute time string; returns epoch ms, or null if invalid/expired. */
function parseAbsoluteTime(time: string): number | null {
  if (!/\d{4}-\d{2}/.test(time)) return null;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return null;
  return ms > Date.now() ? ms : null;
}

type TimeSpec =
  | { type: 'relative'; delayMs: number }
  | { type: 'absolute'; atMs: number; iso: string };

function isCronExpression(timeText: string): boolean {
  const parts = timeText.trim().split(/\s+/);
  return parts.length >= 3 && parts.length <= 6;
}

function formatDelay(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分钟`;

  const hours = Math.floor(minutes / 60);
  const remains = minutes % 60;
  if (remains === 0) return `${hours}小时`;
  return `${hours}小时${remains}分钟`;
}

// ============================================================================
// Session resolution
// ============================================================================

function resolveToFromSession(ctx: OpenClawPluginToolContext): string | null {
  const sessionKey = ctx.sessionKey ?? '';
  const groupPrefix = 'yuanbao:group:';
  const directPrefix = 'yuanbao:direct:';

  const groupIdx = sessionKey.indexOf(groupPrefix);
  if (groupIdx !== -1) {
    const groupCode = sessionKey.slice(groupIdx + groupPrefix.length).trim();
    if (groupCode) return `group:${groupCode}`;
  }

  const directIdx = sessionKey.indexOf(directPrefix);
  if (directIdx !== -1) {
    // sessionKey lowercases userId, so use requesterSenderId instead
    const userId = ctx.requesterSenderId;
    if (userId) return `direct:${userId}`;
  }

  return null;
}

// ============================================================================
// Prompt & name generation
// ============================================================================

function buildReminderPrompt(content: string, intent: 'remind' | 'task'): string {
  if (intent === 'task') {
    return TASK_AGENT_PROMPT_TEMPLATE(content);
  }
  return REMIND_AGENT_PROMPT_TEMPLATE(content);
}

function generateJobName(content: string): string {
  const text = content.trim();
  return text.length > 20 ? `${text.slice(0, 20)}...` : text;
}

// ============================================================================
// Shared base field resolution (reused across all three tiers)
// ============================================================================

type OnceBase = { name: string; atMs: number; atStr: string; message: string };
type CronBase = { name: string; expr: string; tz: string; message: string };

/** Resolves shared fields for a one-time job. */
function resolveOnceBase(params: RemindParams, time: TimeSpec, intent: 'remind' | 'task'): OnceBase {
  const content = params.content!;
  return {
    name: params.name || generateJobName(content),
    atMs: time.type === 'absolute' ? time.atMs : Date.now() + time.delayMs,
    atStr: time.type === 'absolute' ? time.iso : `${Math.max(1, Math.round(time.delayMs / 1000))}s`,
    message: buildReminderPrompt(content, intent),
  };
}

/** Resolves shared fields for a recurring (cron) job. */
function resolveCronBase(params: RemindParams, intent: 'remind' | 'task'): CronBase {
  const content = params.content!;
  return {
    name: params.name || generateJobName(content),
    expr: params.time!.trim(),
    tz: params.timezone || 'Asia/Shanghai',
    message: buildReminderPrompt(content, intent),
  };
}

// ============================================================================
// Gateway mode: job builders
// ============================================================================

/** Builds a Gateway job config for a one-time job. */
function buildOnceJob(params: RemindParams, time: TimeSpec, to: string, accountId: string, intent: 'remind' | 'task') {
  const { name, atMs, message } = resolveOnceBase(params, time, intent);
  return {
    name,
    schedule: { kind: 'at' as const, atMs },
    sessionTarget: 'isolated' as const,
    wakeMode: 'now' as const,
    deleteAfterRun: true,
    payload: { kind: 'agentTurn' as const, message },
    delivery: { mode: 'announce' as const, channel: 'yuanbao' as const, to, accountId },
  };
}

/** Builds a Gateway job config for a recurring (cron) job. */
function buildCronJob(params: RemindParams, to: string, accountId: string, intent: 'remind' | 'task') {
  const { name, expr, tz, message } = resolveCronBase(params, intent);
  return {
    name,
    schedule: { kind: 'cron' as const, expr, tz },
    sessionTarget: 'isolated' as const,
    wakeMode: 'now' as const,
    payload: { kind: 'agentTurn' as const, message },
    delivery: { mode: 'announce' as const, channel: 'yuanbao' as const, to, accountId },
  };
}

// ============================================================================
// CLI mode: argv builders
// ============================================================================

/** Builds CLI argv for `openclaw cron add --at ...` (one-time job). */
function buildOnceCliArgs(params: RemindParams, time: TimeSpec, to: string, accountId: string, intent: 'remind' | 'task'): string[] {
  const { name, atStr, message } = resolveOnceBase(params, time, intent);
  const argv = [
    'openclaw', 'cron', 'add',
    '--name', name,
    '--at', atStr,
    '--message', message,
    '--session', 'isolated',
    '--delete-after-run',
    '--announce',
    '--channel', 'yuanbao',
    '--to', to,
    '--json',
  ];
  if (accountId) argv.push('--account', accountId);
  return argv;
}

/** Builds CLI argv for `openclaw cron add --cron ...` (recurring job). */
function buildCronCliArgs(params: RemindParams, to: string, accountId: string, intent: 'remind' | 'task'): string[] {
  const { name, expr, tz, message } = resolveCronBase(params, intent);
  const argv = [
    'openclaw', 'cron', 'add',
    '--name', name,
    '--cron', expr,
    '--tz', tz,
    '--message', message,
    '--session', 'isolated',
    '--announce',
    '--channel', 'yuanbao',
    '--to', to,
    '--json',
  ];
  if (accountId) argv.push('--account', accountId);
  return argv;
}

// ============================================================================
// Legacy mode: cron params builders (used by executeLegacy)
// ============================================================================

/** Builds Legacy cronToolParams for a one-time job. */
function buildOnceLegacyParams(params: RemindParams, time: TimeSpec, to: string, intent: 'remind' | 'task') {
  const { name, atStr, message } = resolveOnceBase(params, time, intent);
  return { action: 'add', name, at: atStr, session: 'isolated', deleteAfterRun: true, message, channel: 'yuanbao', to };
}

/** Builds Legacy cronToolParams for a recurring (cron) job. */
function buildCronLegacyParams(params: RemindParams, to: string, intent: 'remind' | 'task') {
  const { name, expr, tz, message } = resolveCronBase(params, intent);
  return { action: 'add', name, cron: expr, tz, session: 'isolated', deleteAfterRun: false, message, channel: 'yuanbao', to };
}

// ============================================================================
// Result filtering & error formatting
// ============================================================================

function filterJobsByTarget(cronResult: unknown, to: string | null): unknown[] {
  let jobs: unknown[];
  if (Array.isArray(cronResult)) {
    jobs = cronResult;
  } else if (cronResult && typeof cronResult === 'object') {
    const r = cronResult as Record<string, unknown>;
    jobs = Array.isArray(r.jobs) ? r.jobs : [];
  } else {
    jobs = [];
  }

  return jobs.filter((job: unknown) => {
    const j = job as Record<string, unknown>;
    const delivery = (j.delivery ?? (j.job as Record<string, unknown> | undefined)?.delivery) as
      Record<string, unknown> | undefined;
    if (delivery?.channel !== 'yuanbao') return false;
    return !to || delivery?.to === to;
  });
}

function formatTimeLabel(time: TimeSpec, intent: 'remind' | 'task'): string {
  if (time.type === 'absolute') {
    const d = new Date(time.atMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const label = intent === 'task' ? '执行任务' : '提醒';
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} ${label}`;
  }
  const suffix = intent === 'task' ? '后执行任务' : '后提醒';
  return `${formatDelay(time.delayMs)}${suffix}`;
}

function formatSchedulerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ============================================================================
// Shared parameter validation
// ============================================================================

function validateAddParams(p: RemindParams, resolvedTo: string | null): { error: string } | null {
  if (!p.content?.trim()) return { error: 'action=add 时 content 为必填。' };
  if (!p.time?.trim()) return { error: 'action=add 时 time 为必填。示例：5m / 1h30m / 0 8 * * *' };
  if (!resolvedTo) return { error: '无法确定投递目标。请确保在元宝会话中发起请求。' };
  return null;
}

function validateRemoveParams(p: RemindParams): { error: string } | null {
  if (!p.jobId?.trim()) return { error: 'action=remove 时 jobId 为必填，请先调用 action=list 获取任务 ID。' };
  return null;
}

function parseAndValidateTime(time: string): { timeSpec: TimeSpec } | { error: string } {
  const atMs = parseAbsoluteTime(time);
  if (atMs !== null) {
    if (atMs - Date.now() < 30_000) return { error: '提醒时间不能少于 30 秒。' };
    return { timeSpec: { type: 'absolute', atMs, iso: new Date(atMs).toISOString() } };
  }

  const delayMs = parseRelativeTime(time);
  if (!delayMs || delayMs <= 0) {
    return { error: `无法解析时间 "${time}"。支持 ISO 时间（如 2026-04-29T14:00:00Z）、相对时间（5m/1h/1h30m/2d）或 cron 表达式（如 0 8 * * *）。` };
  }
  if (delayMs < 30_000) return { error: '提醒时间不能少于 30 秒。' };
  return { timeSpec: { type: 'relative', delayMs } };
}

// ============================================================================
// Gateway execute implementation
// ============================================================================

async function executeGateway(
  gatewayTool: GatewayToolCaller,
  p: RemindParams,
  resolvedTo: string | null,
  accountId: string,
) {
  switch (p.action) {
    case 'list': {
      try {
        const cronResult = await gatewayTool('cron.list', { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS }, {});
        const filtered = filterJobsByTarget(cronResult, resolvedTo);
        return json({ status: 'ok', action: 'list', _via: 'gateway', jobs: filtered });
      } catch (error) {
        return json({ error: `查询定时任务失败: ${formatSchedulerError(error)}` });
      }
    }

    case 'remove': {
      const err = validateRemoveParams(p);
      if (err) return json(err);
      try {
        const cronResult = await gatewayTool('cron.remove', { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS }, { jobId: p.jobId!.trim() });
        return json({ status: 'ok', action: 'remove', _via: 'gateway', cronResult });
      } catch (error) {
        return json({ error: `删除定时任务失败: ${formatSchedulerError(error)}` });
      }
    }

    case 'add': {
      const addErr = validateAddParams(p, resolvedTo);
      if (addErr) return json(addErr);

      const intent = p.intent ?? 'remind';

      if (isCronExpression(p.time!)) {
        const job = buildCronJob({ ...p, content: p.content!.trim() }, resolvedTo!, accountId, intent);
        try {
          const cronResult = await gatewayTool('cron.add', { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS }, { job });
          const typeLabel = intent === 'task' ? '循环任务' : '周期提醒';
          return json({
            status: 'ok',
            action: 'add',
            _via: 'gateway',
            summary: `${typeLabel}: "${p.content!.trim()}" (${p.time!.trim()}, tz=${p.timezone || 'Asia/Shanghai'})`,
            cronResult,
          });
        } catch (error) {
          return json({ error: `创建周期任务失败: ${formatSchedulerError(error)}` });
        }
      }

      const timeResult = parseAndValidateTime(p.time!);
      if ('error' in timeResult) return json(timeResult);

      const job = buildOnceJob({ ...p, content: p.content!.trim() }, timeResult.timeSpec, resolvedTo!, accountId, intent);
      try {
        const cronResult = await gatewayTool('cron.add', { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS }, { job });
        return json({
          status: 'ok',
          action: 'add',
          _via: 'gateway',
          summary: `${formatTimeLabel(timeResult.timeSpec, intent)}: "${p.content!.trim()}"`,
          cronResult,
        });
      } catch (error) {
        return json({ error: `创建定时任务失败: ${formatSchedulerError(error)}` });
      }
    }

    default:
      return json({ error: `不支持的 action: ${String(p.action)}。可选值: add/list/remove。` });
  }
}

// ============================================================================
// CLI execute implementation
// Returns null on command failure; validation errors return json directly (no fallback).
// ============================================================================

/**
 * CLI execution tier. Returns null on command failure to trigger Legacy fallback.
 */
async function executeCli(
  runner: PluginCommandRunner,
  p: RemindParams,
  resolvedTo: string | null,
  accountId: string,
): Promise<ReturnType<typeof json> | null> {
  switch (p.action) {
    case 'list': {
      try {
        const result = await runner({ argv: ['openclaw', 'cron', 'list', '--json'], timeoutMs: DEFAULT_CLI_TIMEOUT_MS });
        if (result.code !== 0) return null;
        const parsed = tryParseJson(result.stdout);
        if (parsed) {
          const filtered = filterJobsByTarget(parsed, resolvedTo);
          return json({ status: 'ok', action: 'list', _via: 'cli', jobs: filtered });
        }
        return json({ status: 'ok', action: 'list', _via: 'cli', raw: result.stdout.trim() });
      } catch {
        return null;
      }
    }

    case 'remove': {
      const err = validateRemoveParams(p);
      if (err) return json(err);
      try {
        const result = await runner({
          argv: ['openclaw', 'cron', 'rm', p.jobId!.trim(), '--json'],
          timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
        });
        if (result.code !== 0) return null;
        const parsed = tryParseJson(result.stdout);
        return json({ status: 'ok', action: 'remove', _via: 'cli', cronResult: parsed ?? result.stdout.trim() });
      } catch {
        return null;
      }
    }

    case 'add': {
      const addErr = validateAddParams(p, resolvedTo);
      if (addErr) return json(addErr);

      const intent = p.intent ?? 'remind';
      let argv: string[];
      let summary: string;

      if (isCronExpression(p.time!)) {
        argv = buildCronCliArgs({ ...p, content: p.content!.trim() }, resolvedTo!, accountId, intent);
        const typeLabel = intent === 'task' ? '循环任务' : '周期提醒';
        summary = `${typeLabel}: "${p.content!.trim()}" (${p.time!.trim()}, tz=${p.timezone || 'Asia/Shanghai'})`;
      } else {
        const timeResult = parseAndValidateTime(p.time!);
        if ('error' in timeResult) return json(timeResult);

        argv = buildOnceCliArgs({ ...p, content: p.content!.trim() }, timeResult.timeSpec, resolvedTo!, accountId, intent);
        summary = `${formatTimeLabel(timeResult.timeSpec, intent)}: "${p.content!.trim()}"`;
      }

      try {
        const result = await runner({ argv, timeoutMs: DEFAULT_CLI_TIMEOUT_MS });
        if (result.code !== 0) return null;
        const parsed = tryParseJson(result.stdout);
        return json({ status: 'ok', action: 'add', _via: 'cli', summary, cronResult: parsed ?? result.stdout.trim() });
      } catch {
        return null;
      }
    }

    default:
      return json({ error: `不支持的 action: ${String(p.action)}。可选值: add/list/remove。` });
  }
}

// ============================================================================
// Legacy execute implementation
// ============================================================================

/** Returns PENDING_CRON_CALL to guide the model to invoke the cron tool. */
function executeLegacy(p: RemindParams, resolvedTo: string | null) {
  switch (p.action) {
    case 'list':
      return json({
        status: 'PENDING_CRON_CALL',
        _via: 'legacy',
        completed: false,
        next_step: LEGACY_LIST_NEXT_STEP,
        cronToolParams: { action: 'list' },
        filter: { to: resolvedTo },
      });

    case 'remove': {
      const err = validateRemoveParams(p);
      if (err) return json(err);
      return json({
        status: 'PENDING_CRON_CALL',
        _via: 'legacy',
        completed: false,
        next_step: LEGACY_REMOVE_NEXT_STEP,
        cronToolParams: { action: 'remove', jobId: p.jobId!.trim() },
      });
    }

    case 'add': {
      const addErr = validateAddParams(p, resolvedTo);
      if (addErr) return json(addErr);

      const intent = p.intent ?? 'remind';

      if (isCronExpression(p.time!)) {
        const cronToolParams = buildCronLegacyParams({ ...p, content: p.content!.trim() }, resolvedTo!, intent);
        return json({
          status: 'PENDING_CRON_CALL',
          _via: 'legacy',
          completed: false,
          next_step: LEGACY_ADD_NEXT_STEP,
          cronToolParams,
        });
      }

      const timeResult = parseAndValidateTime(p.time!);
      if ('error' in timeResult) return json(timeResult);

      const cronToolParams = buildOnceLegacyParams({ ...p, content: p.content!.trim() }, timeResult.timeSpec, resolvedTo!, intent);
      return json({
        status: 'PENDING_CRON_CALL',
        _via: 'legacy',
        completed: false,
        next_step: LEGACY_ADD_NEXT_STEP,
        cronToolParams,
      });
    }

    default:
      return json({ error: `不支持的 action: ${String(p.action)}。可选值: add/list/remove。` });
  }
}

// ============================================================================
// Tool definition & registration
// ============================================================================

/** Returns null for non-yuanbao channels. */
function createYuanbaoRemindTool(ctx: OpenClawPluginToolContext) {
  if (!ctx.messageChannel?.includes('yuanbao')) return null;

  const resolvedTo = resolveToFromSession(ctx);
  const accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? '';

  return {
    name: 'yuanbao_remind',
    label: '元宝定时任务',
    description: TOOL_DESCRIPTION,
    parameters: RemindSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as RemindParams;

      const gatewayTool = await resolveCallGatewayTool();
      if (gatewayTool) {
        return executeGateway(gatewayTool, p, resolvedTo, accountId);
      }

      const runner = await resolveRunPluginCommand();
      if (runner) {
        const cliResult = await executeCli(runner, p, resolvedTo, accountId);
        if (cliResult !== null) return cliResult;
        // CLI command failed (non-zero exit or exception), fall through to Legacy
      }

      // Final fallback: guide the model to call cron via PENDING response
      return executeLegacy(p, resolvedTo);
    },
  };
}

export function registerRemindTools(api: OpenClawPluginApi): void {
  api.registerTool(createYuanbaoRemindTool, { optional: false });
}
