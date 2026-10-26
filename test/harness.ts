/**
 * A tiny check harness — the same shape Absence uses, so the two projects read
 * the same way: one line per assertion, a count at the end, a non-zero exit
 * code when something failed.
 */

let passed = 0;
const failures: Array<{ name: string; detail?: string }> = [];

export function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push({ name, detail });
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Assert deep equality by JSON, which is enough for the data this engine returns. */
export function checkEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, a === b ? undefined : `expected ${b}, got ${a}`);
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

/** The running totals, so a suite runner can print one final line. */
export function totals(): { passed: number; failed: number } {
  return { passed, failed: failures.length };
}

export function finish(): void {
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed.`);
  if (failures.length > 0) {
    console.log(`${failures.length} failed:`);
    for (const failure of failures) console.log(`  · ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`);
    process.exitCode = 1;
  }
}
