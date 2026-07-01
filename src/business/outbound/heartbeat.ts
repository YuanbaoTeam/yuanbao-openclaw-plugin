import { WS_HEARTBEAT, WS_HEARTBEAT_GROUP_DISSOLVED_CODE } from "../../access/ws/types.js";
import type { WsHeartbeatValue } from "../../access/ws/types.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import type { MessageHandlerContext } from "../messaging/context.js";

const HEARTBEAT_TIMEOUT_MS = 800;
const DEFAULT_RUNNING_HEARTBEAT_INTERVAL_MS = 2000;
const MAX_RUNNING_HEARTBEAT_IDLE_MS = 30000;

export interface ReplyHeartbeatMeta {
  ctx: MessageHandlerContext;
  account: ResolvedYuanbaoAccount;
  toAccount: string;
  groupCode?: string;
}

export type ReplyHeartbeatOutcome = {
  /** When true, the group is gone — caller must stop the heartbeat loop. */
  shouldStop: boolean;
};

function shouldStopHeartbeatForCode(code: number): boolean {
  return code === WS_HEARTBEAT_GROUP_DISSOLVED_CODE;
}

/**
 * Send reply status heartbeat (best effort, no throw, no interruption to main flow).
 */
export async function emitReplyHeartbeat(params: ReplyHeartbeatMeta & {
  heartbeat: WsHeartbeatValue;
  sendTime: number;
}): Promise<ReplyHeartbeatOutcome> {
  const { ctx, account, toAccount, groupCode, heartbeat, sendTime } = params;
  const log = createLog("reply-heartbeat");
  const fromAccount = account.botId?.trim() ?? "";
  const targetAccount = toAccount.trim();
  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`heartbeat timeout(${timeoutMs}ms)`)),
      timeoutMs,
    );
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

  if (!ctx.wsClient) {
    log.warn(`[${account.accountId}] heartbeat send failed: wsClient unavailable`);
    return { shouldStop: false };
  }

  if (!fromAccount || !targetAccount) {
    log.warn(`[${account.accountId}] heartbeat send failed: from/to account missing`, {
      fromAccount,
      toAccount: targetAccount,
      groupCode,
      heartbeat,
    });
    return { shouldStop: false };
  }

  try {
    if (groupCode) {
      const rsp = await withTimeout(
        ctx.wsClient.sendGroupHeartbeat({
          from_account: fromAccount,
          to_account: targetAccount,
          group_code: groupCode,
          send_time: sendTime,
          heartbeat,
        }),
        HEARTBEAT_TIMEOUT_MS,
      );
      if (rsp.code !== 0) {
        log.warn(`[${account.accountId}] group reply heartbeat send failed: code=${rsp.code}, msg=${rsp.msg ?? rsp.message ?? ""}`);
        if (shouldStopHeartbeatForCode(rsp.code)) {
          log.warn(`[${account.accountId}] group dissolved (code=${rsp.code}), stopping reply heartbeat`);
        }
      }
      return { shouldStop: shouldStopHeartbeatForCode(rsp.code) };
    }

    const rsp = await withTimeout(
      ctx.wsClient.sendPrivateHeartbeat({
        from_account: fromAccount,
        to_account: targetAccount,
        heartbeat,
      }),
      HEARTBEAT_TIMEOUT_MS,
    );
    if (rsp.code !== 0) {
      log.warn(`[${account.accountId}] C2C reply heartbeat send failed: code=${rsp.code}, msg=${rsp.msg ?? rsp.message ?? ""}`);
    }
    return { shouldStop: shouldStopHeartbeatForCode(rsp.code) };
  } catch (err) {
    log.warn(`[${account.accountId}] reply heartbeat send error: ${String(err)}`);
    return { shouldStop: false };
  }
}

export interface ReplyHeartbeatController {
  emit(heartbeat: WsHeartbeatValue): void;
  /** Send FINISH if RUNNING was ever started and FINISH not yet sent; always clears timers. */
  finishIfNeeded(): void;
  onReplySent(): void;
  stop(): void;
}

export function createReplyHeartbeatController(params: {
  meta: ReplyHeartbeatMeta;
  runningIntervalMs?: number;
}): ReplyHeartbeatController {
  const { meta } = params;
  const runningIntervalMs = params.runningIntervalMs ?? DEFAULT_RUNNING_HEARTBEAT_INTERVAL_MS;
  let runningHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let runningHeartbeatActive = false;
  let runningHeartbeatStartTime: number | null = null;
  let lastRunningEmitAt: number | null = null;
  let runningEverStarted = false;
  let finishEmitted = false;
  let forceStopped = false;

  const abortHeartbeat = (): void => {
    forceStopped = true;
    finishEmitted = true;
    stop();
  };

  const handleOutcome = (outcome: ReplyHeartbeatOutcome): void => {
    if (outcome.shouldStop) {
      abortHeartbeat();
    }
  };

  const send = (heartbeat: WsHeartbeatValue, sendTime: number): void => {
    void emitReplyHeartbeat({
      ...meta,
      heartbeat,
      sendTime,
    }).then(handleOutcome);
  };

  const sendFinish = (): void => {
    if (finishEmitted) {
      return;
    }
    finishEmitted = true;
    send(WS_HEARTBEAT.FINISH, Date.now());
  };

  const sendRunningHeartbeatAndSchedule = async (): Promise<void> => {
    if (finishEmitted || !runningHeartbeatActive) {
      return;
    }
    if (runningHeartbeatStartTime === null) {
      return;
    }
    if (lastRunningEmitAt === null) {
      return;
    }
    if (Date.now() - lastRunningEmitAt > MAX_RUNNING_HEARTBEAT_IDLE_MS) {
      stop();
      return;
    }
    const outcome = await emitReplyHeartbeat({
      ...meta,
      heartbeat: WS_HEARTBEAT.RUNNING,
      sendTime: runningHeartbeatStartTime,
    });
    if (outcome.shouldStop) {
      abortHeartbeat();
      return;
    }
    if (finishEmitted || !runningHeartbeatActive) {
      return;
    }
    runningHeartbeatTimer = setTimeout(() => {
      void sendRunningHeartbeatAndSchedule();
    }, runningIntervalMs);
  };

  const stop = (): void => {
    runningHeartbeatActive = false;
    runningHeartbeatStartTime = null;
    lastRunningEmitAt = null;
    if (runningHeartbeatTimer) {
      clearTimeout(runningHeartbeatTimer);
      runningHeartbeatTimer = null;
    }
  };

  const startRunning = (): void => {
    if (runningHeartbeatActive) {
      return;
    }
    runningHeartbeatActive = true;
    runningHeartbeatStartTime = Date.now();
    lastRunningEmitAt = Date.now();
    void sendRunningHeartbeatAndSchedule();
  };

  const finishIfNeeded = (): void => {
    stop();
    if (runningEverStarted && !forceStopped) {
      sendFinish();
    }
  };

  const emit = (heartbeat: WsHeartbeatValue): void => {
    if (heartbeat === WS_HEARTBEAT.RUNNING) {
      if (finishEmitted) {
        return;
      }
      runningEverStarted = true;
      if (runningHeartbeatActive) {
        lastRunningEmitAt = Date.now();
        return;
      }
      startRunning();
      return;
    }
    stop();
    sendFinish();
  };

  return {
    emit,
    finishIfNeeded,
    onReplySent: finishIfNeeded,
    stop,
  };
}
