/**
 * Message delivery layer.
 *
 * Wraps C2C/group chat differences, auto-routes to the corresponding transport function based on SendTarget.
 * Used by create-sender and actions/xxx/send.ts.
 *
 * Internally calls transport.sendC2CMsgBody / transport.sendGroupMsgBody directly.
 */

import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { sendC2CMsgBody, sendGroupMsgBody } from "../../infra/transport.js";
import type { ModuleLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { SendResult } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

/** Minimal context required by deliver */
export interface DeliverTarget {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C: toAccount; group chat: groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  traceContext?: YuanbaoTraceContext;
  /**
   * JSON string forwarded verbatim to the IM server as `cloud_custom_data`
   * (currently used to carry `topicId` so the front-end can attribute the
   * reply to the originating topic). Only applied on group sends today —
   * C2C does not have a corresponding proto field.
   */
  cloudCustomData?: string;
  /**
   * Optional caller-provided logger. Forwarded to transport so out-frame logs
   * (e.g. `[group] outbound frame`) share the pipeline log sink and land in
   * gateway.log. Falls back to transport's own createLog when omitted.
   */
  log?: ModuleLog;
}

/**
 * Unified message delivery.
 * Auto-routes to C2C or group chat transport based on isGroup flag.
 */
export async function deliver(
  dt: DeliverTarget,
  msgBody: YuanbaoMsgBodyElement[],
): Promise<SendResult> {
  return dt.isGroup
    ? sendGroupMsgBody({
      account: dt.account,
      groupCode: dt.target,
      msgBody,
      fromAccount: dt.fromAccount,
      refMsgId: dt.refMsgId,
      refFromAccount: dt.refFromAccount,
      wsClient: dt.wsClient,
      traceContext: dt.traceContext,
      cloudCustomData: dt.cloudCustomData,
      log: dt.log,
    })
    : sendC2CMsgBody({
      account: dt.account,
      toAccount: dt.target,
      msgBody,
      fromAccount: dt.fromAccount,
      wsClient: dt.wsClient,
      groupCode: dt.groupCode,
      traceContext: dt.traceContext,
    });
}
