/**
 * WebSocket client multi-account storage
 *
 * Uses Map<accountId, WsClient> to manage concurrent connections.
 * Each account's WsClient reference is stored when the ws-gateway starts
 * and consumed by the outbound sendText path.
 *
 * Uses globalThis + Symbol.for() to guarantee a process-wide singleton,
 * because the bundled channel entry may load this module in separate scopes
 * (plugin scope vs tool-registration scope).
 */
import type { YuanbaoWsClient } from "./client.js";

const WS_CLIENTS_KEY = Symbol.for("yuanbao:ws:activeClients");

const activeClients: Map<string, YuanbaoWsClient> =
  (globalThis as Record<symbol, unknown>)[WS_CLIENTS_KEY] as Map<string, YuanbaoWsClient>
  ?? ((globalThis as Record<symbol, unknown>)[WS_CLIENTS_KEY] = new Map<string, YuanbaoWsClient>());

/**
 * Store a WebSocket client reference for the given account.
 */
export function setActiveWsClient(accountId: string, client: YuanbaoWsClient | null): void {
  if (client) {
    activeClients.set(accountId, client);
  } else {
    activeClients.delete(accountId);
  }
}

/**
 * Get the WebSocket client reference for the given account.
 */
export function getActiveWsClient(accountId: string): YuanbaoWsClient | null {
  return activeClients.get(accountId) ?? null;
}

/**
 * Get all active WebSocket clients.
 */
export function getAllActiveWsClients(): ReadonlyMap<string, YuanbaoWsClient> {
  return activeClients;
}
