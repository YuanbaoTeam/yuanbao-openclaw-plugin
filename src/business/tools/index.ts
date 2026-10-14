/**
 * Tools registration factory.
 *
 * Centralized tool registration logic, grouped by category.
 * Plugin entry only needs to call registerTools(api) to register all tools.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerGroupTools } from "./group.js";
import { registerMemberTools } from "./member.js";
import { registerRemindTools } from "./remind.js";
import { registerXCardSendTool } from "./xcard-send.js";

/**
 * Register all tools.
 *
 * Call each registration function by category in order; to add a new category, simply append here.
 *
 * @param api - OpenClaw plugin API
 */
export function registerTools(api: OpenClawPluginApi): void {
  // -- Member --
  registerMemberTools(api);

  // -- Group info --
  registerGroupTools(api);

  // -- Scheduled reminder --
  registerRemindTools(api);

  // -- AI-authored interactive cards (built-in template tool is temporarily not registered) --
  registerXCardSendTool(api);

  // -- Append new categories here --
  // registerXxxTools(api);
}
