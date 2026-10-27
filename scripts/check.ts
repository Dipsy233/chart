/**
 * Run every check: `npm run check`.
 *
 * Each test module prints its own results and sets the exit code on failure, so
 * this file only has to load them in order and print the grand total.
 */

import { section, totals } from "../test/harness.ts";

const modules = [
  "../test/facts.test.ts",
  "../test/regimen.test.ts",
  "../test/defaults.test.ts",
  "../test/report.test.ts",
  "../test/record.test.ts",
  "../test/store.test.ts",
  "../test/editor.test.ts",
  "../test/api.test.ts",
];

section("chart");
for (const module of modules) {
  await import(module);
}

const { passed, failed } = totals();
console.log(`\nchart: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
