#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog } from "@a2ui/web_core";
import { A2uiGenerator, CatalogConfig, ExpressFormatFactory } from "@a2ui/agent";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPath = resolve(repoRoot, "skills/xcard-generator/references/specification/v1_0/catalogs/xcard/catalog.json");
const agentCatalogPath = resolve(repoRoot, "src/business/xcard/agent-catalog.json");
const expressPromptPath = resolve(repoRoot, "skills/xcard-generator/references/express-prompt.md");

const BANNED_COMPONENTS = new Set(["WebCard", "xCardTemplate"]);
const ALLOWED_MESSAGES = ["createSurface", "updateComponents", "updateDataModel"];

function stableStringify(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function cloneWithAgentDialect(value, key) {
  if (Array.isArray(value)) return value.map((item) => cloneWithAgentDialect(item));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneWithAgentDialect(v, k);

  if (key === "child" && out.type === "string") {
    return { $ref: "common_types.json#/$defs/Child" };
  }
  if (key === "children") {
    return { $ref: "common_types.json#/$defs/ChildList" };
  }

  const props = out.properties;
  if (
    props
    && typeof props === "object"
    && !Array.isArray(props)
    && Object.keys(props).length === 1
    && props.path
    && Array.isArray(out.required)
    && out.required.length === 1
    && out.required[0] === "path"
  ) {
    out.properties = { "@path": props.path };
    out.required = ["@path"];
  }

  return out;
}

function pruneCatalog(catalog) {
  const components = {};
  for (const [name, schema] of Object.entries(catalog.components ?? {})) {
    if (!BANNED_COMPONENTS.has(name)) components[name] = schema;
  }
  return { ...catalog, components };
}

function buildAnyComponent(components) {
  return {
    oneOf: Object.keys(components).map((name) => ({ $ref: `#/components/${name}` })),
    discriminator: { propertyName: "component" },
  };
}

function buildAnyFunction(functions) {
  const names = Object.keys(functions ?? {});
  if (names.length === 0) return { not: {} };
  return {
    oneOf: names.map((name) => ({ $ref: `#/functions/${name}` })),
    discriminator: { propertyName: "call" },
  };
}

function ensureComponentDiscriminators(catalog) {
  const components = {};
  for (const [name, schema] of Object.entries(catalog.components ?? {})) {
    const properties = { ...(schema.properties ?? {}) };
    if (!properties.component) properties.component = { const: name };
    const required = Array.from(new Set([...(schema.required ?? []), "component"]));
    components[name] = { ...schema, properties, required };
  }
  return { ...catalog, components };
}

function deriveAgentCatalog(canonical, canonicalHash) {
  let catalog = cloneWithAgentDialect(canonical);
  catalog = ensureComponentDiscriminators(catalog);
  catalog = pruneCatalog(catalog);
  catalog.instructions = [
    "Use this Yuanbao xCard catalog for compact interactive cards.",
    "Generate self-contained cards only. Do not use WebCard, xCardTemplate, tracking, host environment values, or undeclared host functions.",
    "Prefer restrained Yuanbao visual hierarchy: clear text, token colors, modest spacing, no unsupported gradients, shadows, blur, transforms, or raw colors.",
    "Expose a single root component named root. Put visible completion feedback in the card and include a human-readable resultText in every event context.",
  ].join("\n\n");
  catalog.metadata = {
    ...(catalog.metadata ?? {}),
    extensions: {
      ...((catalog.metadata && catalog.metadata.extensions) || {}),
      openclaw_agent_catalog: {
        source: "xcard-generator canonical catalog",
        sourceSha256: canonicalHash,
      },
    },
  };
  catalog.$defs = {
    ...(catalog.$defs ?? {}),
    anyComponent: buildAnyComponent(catalog.components ?? {}),
    anyFunction: buildAnyFunction(catalog.functions ?? {}),
  };
  return catalog;
}

function adaptPromptSnippetForYuanbaoToolUse(snippet) {
  return snippet.replace(
    /IMPORTANT: You MUST always surround the entire A2UI Express block with the literal sentinel tags `<a2ui>` and `<\/a2ui>` \(always include both the opening and closing tags; do NOT wrap the tags in backticks or replace the opening tag with a markdown code fence such as ```a2ui\)\./,
    "IMPORTANT: In a Yuanbao final answer, embed exactly one raw `<a2ui>...</a2ui>` block directly in the text. Plain prose may appear before or after the block when useful, but the block itself MUST NOT be wrapped in Markdown/code fences. When passing Express to a tool `express` parameter, pass only the raw body without `<a2ui>` tags.",
  );
}

function buildCompactExpressQuickReference() {
  return [
    "## Compact Express Quick Reference",
    "",
    "Use this short section before the long component catalog. It is the mental model for one-shot Yuanbao freeform xCards.",
    "",
    "Final answer shape when prose is useful: plain text, then a raw A2UI block, then more plain text. Do not add Markdown/code fences around the A2UI block.",
    "",
    "Here is your card:",
    "<a2ui>",
    "$/title = \"任务清单\"",
    "$/items = [{label: \"整理记录\", value: \"已完成\"}, {label: \"复核时间表\", value: \"待处理\"}]",
    "item = Column(children=[",
    "  Text($label),",
    "  Text($value, variant=\"caption\")",
    "])",
    "root = Card(Column(children=[",
    "  Text($/title, variant=\"h4\"),",
    "  List(_template($/items, item))",
    "]))",
    "</a2ui>",
    "You can adjust the items as needed.",
    "",
    "- The `<a2ui>` block must be raw inline text, not a Markdown/code fenced block.",
    "- Inside `<a2ui>` write A2UI Express only: data assignments, component variables, and exactly one `root = ...` component.",
    "- Do not write JSON UI schemas such as `{\"type\":\"list\"}` or `{\"type\":\"product_card\"}`; those are not Express and fail because they do not define `root`.",
    "- For repeated data, do not index with `$/items[0]`; define an item template and render it with `List(_template($/items, item))`. Inside the template use relative bindings such as `$label` and `$value`.",
    "- `Text.variant` is only `h1`, `h2`, `h3`, `h4`, `h5`, `caption`, `footnote`, or `body`. Do not use `body1`, `body2`, `title`, `subtitle`, or `headline`.",
    "- Prefer the simple component set unless the user asks for a richer interaction: `Card`, `Column`, `Row`, `Text`, `Image`, `Button`, `List`, `_template`, and `Event`.",
    "",
  ].join("\n");
}

function buildPrompt(agentCatalog, canonicalHash) {
  const catalog = Catalog.fromJson(agentCatalog);
  const generator = new A2uiGenerator(
    [new CatalogConfig(catalog)],
    undefined,
    new ExpressFormatFactory({ allowedMessages: ALLOWED_MESSAGES }),
  );
  const processor = generator.createProcessor({
    "1.0": { supportedCatalogIds: [agentCatalog.catalogId] },
  });
  return [
    "<!-- Generated by scripts/generate-a2ui-agent-catalog.mjs; do not edit manually. -->",
    `<!-- source: ${canonicalPath.replace(repoRoot + "/", "")} -->`,
    `<!-- sourceSha256: ${canonicalHash} -->`,
    "",
    "# Yuanbao xCard Express Prompt",
    "",
    buildCompactExpressQuickReference(),
    adaptPromptSnippetForYuanbaoToolUse(processor.promptSnippet.trim()),
    "",
    "## Yuanbao OpenClaw Runtime Contract",
    "",
    "- Default path: for a one-shot freeform card, directly embed exactly one raw `<a2ui>...</a2ui>` block containing Express in the final answer. Plain prose may appear before or after it when useful, but never wrap the block in Markdown/code fences. The plugin intercepts it and sends one xCard; the user never sees the DSL. This path cannot self-correct, so keep the Express simple and valid.",
    "- The block content is A2UI Express, not JSON. Do not output invented schemas such as `{\"type\":\"list\"}` or `{\"type\":\"product_card\"}`; use data assignments plus `root = Card(...)`.",
    "- Tool path: call `yuanbao_xcard_send` / `yuanbao_xcard_update` with the `express` parameter when you need waitForAction, explicit mode/audience/title, an update to an existing surface, or same-turn retry after compiler errors. Pass only the raw Express body: no `<a2ui>` tags, Markdown fences, JSONL envelopes, or prose.",
    "- Generated cards must be self-contained. Do not depend on WebCard, xCardTemplate, tracking, host environment values, or undeclared host functions.",
    "- Include a visible post-action result state. Every `Event(...)` context must include stable business values and a human-readable `resultText`.",
    "- For follow-up changes to an existing generated card, prefer updating the original surface when the runtime provides a surface id; do not create a replacement card for the same business state.",
    "",
  ].join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const canonicalText = readFileSync(canonicalPath, "utf8");
  const canonical = JSON.parse(canonicalText);
  const canonicalHash = sha256(canonicalText);
  const agentCatalog = deriveAgentCatalog(canonical, canonicalHash);
  const catalogText = stableStringify(agentCatalog);
  const promptText = buildPrompt(agentCatalog, canonicalHash);

  if (check) {
    const currentCatalog = readFileSync(agentCatalogPath, "utf8");
    const currentPrompt = readFileSync(expressPromptPath, "utf8");
    const diffs = [];
    if (currentCatalog !== catalogText) diffs.push(agentCatalogPath);
    if (currentPrompt !== promptText) diffs.push(expressPromptPath);
    if (diffs.length > 0) {
      console.error(`Generated A2UI agent artifacts are stale:\n${diffs.join("\n")}`);
      process.exit(1);
    }
    console.log("A2UI agent artifacts are up to date.");
    return;
  }

  writeFileSync(agentCatalogPath, catalogText);
  writeFileSync(expressPromptPath, promptText);
  console.log(`Wrote ${agentCatalogPath}`);
  console.log(`Wrote ${expressPromptPath}`);
  console.log(`Prompt characters: ${promptText.length}`);
}

main();
