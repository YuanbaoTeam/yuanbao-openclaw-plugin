/**
 * Middleware: parse thread/topic info from cloud_custom_data.ext_map.thread_info.
 */

import { parseThreadInfoFromCloudCustomData } from "../../messaging/thread-info.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveThreadInfo: MiddlewareDescriptor = {
  name: "resolve-thread-info",
  handler: async (ctx, next) => {
    const threadInfo = parseThreadInfoFromCloudCustomData(ctx.raw.cloud_custom_data);

    if (threadInfo) {
      ctx.threadInfo = threadInfo;
      const titles = threadInfo.threads.map(t => t.thread_title).join(", ");
      ctx.log.info(`[resolve-thread-info] detected thread info, threads: ${titles}`);
    }

    await next();
  },
};
