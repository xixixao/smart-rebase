#!/usr/bin/env bun

/**
 * End-to-end test runner for gitlab-rebase.
 *
 * Runs every scenario from ./scenarios.ts in sequence. Each scenario gets its
 * own temporary GitLab project (created via `glab`) and is torn down at the
 * end regardless of pass/fail.
 *
 * Run with --interactive to pause before each step and require Enter.
 * Run with --only=<name> to run a single scenario by name.
 *
 * Prerequisites:
 *   - glab authenticated (glab auth login)
 *   - GITLAB_TOKEN env var set (for gitlab-rebase itself)
 */

import { parseArgs } from "util";
import { runScenario, isInteractive, setInteractive } from "./helpers";
import { allScenarios } from "./scenarios";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    only: { type: "string" },
    interactive: { type: "boolean" },
  },
  strict: true,
});

setInteractive(values.interactive ?? false);

const onlyName = values.only;
const scenarios = onlyName ? allScenarios.filter((s) => s.name === onlyName) : allScenarios;
if (scenarios.length === 0) {
  console.error(`No scenarios match --only=${onlyName}.`);
  console.error(`Available: ${allScenarios.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

console.log(`\x1b[1mGitLab Rebase — E2E Tests\x1b[0m`);
console.log(`  scenarios: ${scenarios.map((s) => s.name).join(", ")}`);
if (isInteractive()) console.log(`  mode:      interactive (confirm each step)`);

let allPassed = true;
for (const scenario of scenarios) {
  const passed = await runScenario(scenario);
  if (!passed) allPassed = false;
}

if (!allPassed) {
  console.error(`\n\x1b[1;31m✗ Some E2E scenarios failed${"\x1b[0m"}`);
  process.exit(1);
}
console.log(`\n\x1b[1;32m✓ All E2E scenarios passed${"\x1b[0m"}`);
