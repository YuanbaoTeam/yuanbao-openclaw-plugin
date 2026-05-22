/**
 * TIMImageElem message handler.
 *
 * Image message: on input, extracts image URL to media list and returns
 * [image:{name}_{w}_{h}.{ext}] placeholder; on output, constructs image message body.
 */

import { sanitizeMediaFilename } from "../../utils/media.js";
import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

/**
 * Build a descriptive filename for an image from its uuid and dimensions.
 * e.g. uuid="c9a1b3f8784898.jpeg", w=720, h=1793 → "c9a1b3f8784898_720_1793.jpeg"
 * Falls back to plain uuid (no dimensions available) or "image{N}" (no uuid).
 */
function buildImageMediaName(
  uuid: string,
  w: number | undefined,
  h: number | undefined,
  fallbackIndex: number,
): string {
  const fallback = `image${fallbackIndex}`;
  if (!uuid) {
    return fallback;
  }
  const dotIdx = uuid.lastIndexOf(".");
  const stem = dotIdx > 0 ? uuid.slice(0, dotIdx) : uuid;
  const ext = dotIdx > 0 ? uuid.slice(dotIdx) : "";
  const raw = w && h ? `${stem}_${w}_${h}${ext}` : uuid;
  return sanitizeMediaFilename(raw, fallback);
}

export const imageHandler: MessageElemHandler = {
  msgType: "TIMImageElem",

  /**
   * Extract image URL and record to media list.
   * Returns [image:{mediaName}] placeholder; undefined if no URL.
   * mediaName encodes uuid + selected resolution (width x height).
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    const imageInfoArray = elem.msg_content?.image_info_array as
      | Array<{ type?: number; url?: string; width?: number; height?: number }>
      | undefined;
    // Prefer medium-size image (index 1) for download; fall back to original (index 0)
    const imageInfo = imageInfoArray?.[1] || imageInfoArray?.[0];
    if (imageInfo?.url) {
      const uuid = (elem.msg_content?.uuid as string) ?? "";
      const imageCount = resData.medias.filter(m => m.mediaType === "image").length;
      const mediaName = buildImageMediaName(uuid, imageInfo.width, imageInfo.height, imageCount + 1);
      resData.medias.push({ mediaType: "image", url: imageInfo.url, mediaName });
      return `[image:${mediaName}]`;
    }
    return undefined;
  },

  /**
   * Build TIMImageElem message body.
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    const imageInfoArray = data.imageInfoArray ?? [
      {
        type: 1, // Original image
        url: data.url as string,
      },
    ];
    return [
      {
        msg_type: "TIMImageElem",
        msg_content: {
          ...(data.uuid ? { uuid: data.uuid } : {}),
          ...(data.imageFormat ? { image_format: data.imageFormat } : {}),
          image_info_array: imageInfoArray,
        } as MsgBodyItemType["msg_content"],
      },
    ];
  },
};
