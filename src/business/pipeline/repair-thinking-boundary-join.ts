const CLAUSE_OR_SENTENCE_END_RE = /[.!?。！？…，、；：]/;

function isClauseOrSentenceEndChar(ch: string): boolean {
  return CLAUSE_OR_SENTENCE_END_RE.test(ch);
}

/**
 * SDK may insert spurious newlines when visible text resumes after a thinking block.
 * Repair only the join between `prefix` (text before reasoning ended) and `incoming`
 * cumulative partial text.
 *
 * Preserve:
 * - verse line breaks after Chinese comma (，)
 * - paragraph breaks (\n\n+) after clause/sentence endings
 */
export function repairThinkingBoundaryJoin(prefix: string, incoming: string): string {
  if (!prefix || !incoming.startsWith(prefix)) {
    return incoming;
  }
  if (prefix.endsWith("\n")) {
    return incoming;
  }

  const suffix = incoming.slice(prefix.length);
  if (!suffix.startsWith("\n")) {
    return incoming;
  }

  const lastChar = prefix.slice(-1);

  // Chinese verse lines typically break after ，.
  if (lastChar === "，" && suffix.startsWith("\n") && !suffix.startsWith("\n\n")) {
    return incoming;
  }

  // Paragraph breaks after clause/sentence endings stay intact.
  if (suffix.startsWith("\n\n") && isClauseOrSentenceEndChar(lastChar)) {
    return incoming;
  }

  if (suffix.startsWith("\n\n")) {
    return prefix + suffix.replace(/^\n+/, "");
  }

  return prefix + suffix.replace(/^\n(?!\n)/, "");
}

/** Apply all recorded thinking-boundary repairs in order (oldest first). */
export function repairAllThinkingBoundaryJoins(prefixes: readonly string[], incoming: string): string {
  let text = incoming;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix) && text.length > prefix.length) {
      text = repairThinkingBoundaryJoin(prefix, text);
    }
  }
  return text;
}
