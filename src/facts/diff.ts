/** Line counts of a unified diff. The `+++`/`---` headers are not changes. */
export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Number of lines in a file's text; an empty file has none. */
export function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

/** The first non-empty line — enough to name a thought in one row. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(thinking…)";
}
