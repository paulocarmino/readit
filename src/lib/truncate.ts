/** Result of slicing a long text for the agent. */
export interface TruncateResult {
  text: string;
  /** Index to pass as start_index to get the next chunk, when there is more. */
  nextIndex?: number;
  total: number;
}

/**
 * Returns a window of `text` starting at `startIndex` with at most `maxChars` characters,
 * appending a footer that tells the agent how to fetch the next chunk.
 * Tries to cut on a line break so markdown is not split mid-line.
 *
 * @param text - Full text
 * @param maxChars - Maximum characters in the window
 * @param startIndex - Offset of the window
 * @returns The window plus pagination info
 */
export function truncate(text: string, maxChars: number, startIndex = 0): TruncateResult {
  const total = text.length;
  if (startIndex >= total) {
    return { text: `[start_index ${startIndex} is past the end (total ${total} chars).]`, total };
  }

  let end = Math.min(startIndex + maxChars, total);
  if (end < total) {
    const lineBreak = text.lastIndexOf('\n', end);
    if (lineBreak > startIndex + maxChars * 0.8) end = lineBreak + 1;
  }

  let chunk = text.slice(startIndex, end);
  if (startIndex > 0) chunk = `[... continuing from char ${startIndex} of ${total}]\n\n${chunk}`;
  if (end >= total) return { text: chunk, total };

  return {
    text: `${chunk}\n\n[... truncated: showing chars ${startIndex}-${end} of ${total}. Call read_page again with the same arguments and start_index=${end} to continue.]`,
    nextIndex: end,
    total,
  };
}
