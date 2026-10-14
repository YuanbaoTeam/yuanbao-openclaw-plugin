/**
 * xCard protocol constants.
 *
 * xCard = A2UI v1.0 interactive card rendered by the Yuanbao app (official spec:
 * xcard.pages.woa.com). The wire envelope is implemented in transport-im1007.ts; OpenClaw
 * binding metadata rides in `createSurface.metadata.extensions[OPENCLAW_EXTENSION_KEY]`.
 */

export const OPENCLAW_EXTENSION_KEY = "com_tencent_yuanbao_openclaw";
/** `protocol` of the App upevent payload. */
export const XCARD_EVENT_PROTOCOL = "yuanbao.openclaw.xcard/1";
/** v0.9 / v0.9.1 renderers were removed from the client; every message must carry v1.0 */
export const A2UI_VERSION = "v1.0";
export const XCARD_CATALOG_ID = "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json";
/** Renderer reports this when createSurface.metadata.extensions.xCardMinRendererVersion is not met */
export const MIN_RENDERER_VERSION_ERROR = "MIN_RENDERER_VERSION_NOT_SATISFIED";

/** Default / max time a tool call may block waiting for a user operation */
export const DEFAULT_WAIT_TIMEOUT_SEC = 120;
export const MAX_WAIT_TIMEOUT_SEC = 300;
/** Card lifetime in the in-memory registry; events after this are answered with `unknown` */
export const SURFACE_TTL_MS = 30 * 60_000;
/** Per-account cap on live surfaces (oldest evicted first) */
export const MAX_SURFACES_PER_ACCOUNT = 200;
/** Remembered request ids per surface for receipt idempotency */
export const MAX_SEEN_REQUEST_IDS = 50;
/**
 * Upper bound of the custom elem's `msg_content.data` (UTF-8 bytes, content double-encoded inside).
 * One IM packet is 12 KiB including protobuf framing, the other msg fields and the packet header,
 * so ~2 KiB is left as headroom.
 */
export const MAX_CARD_CONTENT_BYTES = 10 * 1024;
/** A clicked button's userMessage may also arrive as a chat message; drop such echoes for this long */
export const USER_MESSAGE_ECHO_TTL_MS = 30_000;
