/**
 * Production-aligned markdown chunker for unit tests (atomic table + openclaw fence).
 */
import { chunkMarkdownText as openclawChunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { mdAtomic } from "../../utils/markdown.js";

export function chunkMarkdownText(text: string, limit: number): string[] {
  return mdAtomic.chunkAware(text, limit, openclawChunkMarkdownText);
}
