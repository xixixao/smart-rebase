/**
 * Shared helpers for the smart-rebase end-to-end tests.
 *
 * Each scenario gets its own GitLab project (created via `glab`), runs a
 * sequence of git/glab operations against it, and tears it down at the end.
 * The helpers in this file abstract the repetitive parts so individual
 * scenarios can read like a story rather than a script.
 */

import { $ } from "bun";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESET = "\x1b[0m";
const BOLD_BLUE = "\x1b[1;34m";
const GREEN = "\x1b[32m";
const RED = "\x1b[1;31m";
const DIM = "\x1b[2m";

let interactive = false;
export function setInteractive(value: boolean): void {
  interactive = value;
}
export function isInteractive(): boolean {
  return interactive;
}

// SIGINT handling: when the user hits Ctrl-C, run the currently-active
// scenario's cleanup before exiting so we don't leak a remote GitLab project.
// In non-interactive mode the default SIGINT terminates the process before
// `runScenario`'s finally block fires; this handler bridges that gap.
let activeCleanup: (() => Promise<void>) | null = null;
let sigintHandled = false;

process.on("SIGINT", () => {
  if (sigintHandled) {
    // Second Ctrl-C: don't wait for cleanup, exit now.
    process.stderr.write(`\n${RED}✗ Forcing exit (cleanup may be incomplete)${RESET}\n`);
    process.exit(130);
  }
  sigintHandled = true;
  void runSigintCleanup();
});

async function runSigintCleanup(): Promise<void> {
  process.stderr.write(`\n${RED}✗ Interrupted — cleaning up...${RESET}\n`);
  const cleanup = activeCleanup;
  activeCleanup = null;
  if (cleanup) {
    try {
      await cleanup();
    } catch (e) {
      process.stderr.write(`Cleanup error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.exit(130);
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

export async function step(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n${BOLD_BLUE}▶ ${name}${RESET}\n`);
  if (isInteractive()) {
    process.stdout.write(`${DIM}  Press Enter to run...${RESET}`);
    await waitForEnter();
  }
  await fn();
  process.stdout.write(`${GREEN}  ✓ done${RESET}\n`);
}

export function encodeProject(path: string): string {
  return encodeURIComponent(path);
}

/** Calls the GitLab API via glab and returns parsed JSON. */
export async function glabApi(endpoint: string, extraArgs: string[] = []): Promise<unknown> {
  const result = await $`glab api ${endpoint} ${extraArgs}`.quiet();
  const text = result.stdout.toString().trim();
  if (!text) return null;
  return JSON.parse(text);
}

export interface E2EContext {
  /** Directory containing the local clone. */
  repoDir: string;
  /** GitLab project path: `namespace/repo`. */
  projectPath: string;
  /** Path to smart-rebase's entry.ts so each scenario invokes the same binary. */
  entryScript: string;
  workDir: string;
  scenarioName: string;
}

interface SetupResult {
  ctx: E2EContext;
  cleanup: () => Promise<void>;
}

/**
 * Creates a fresh GitLab project and clones it locally. The returned cleanup
 * function deletes both the local clone and the remote project; scenarios
 * should call it from a `finally` block so a failure mid-scenario still tears
 * the project down.
 */
export async function setupScenario(scenarioName: string): Promise<SetupResult> {
  const repoName = `smart-rebase-e2e-${scenarioName}-${Date.now()}`;
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "smart-rebase-e2e-")));
  const repoDir = join(workDir, repoName);
  const entryScript = join(import.meta.dir, "..", "..", "src", "manual", "entry.ts");

  const user = (await glabApi("user")) as { username: string };
  const namespace = user.username;
  const projectPath = `${namespace}/${repoName}`;

  console.log(`  user:         ${namespace}`);
  console.log(`  project:      ${projectPath}`);
  console.log(`  work dir:     ${workDir}`);

  // Idempotent cleanup so that both the SIGINT path and the normal finally
  // path can call it without doing the work twice. `projectCreated` gates the
  // remote-delete: if SIGINT fires before the project is created we shouldn't
  // even try to delete (and we won't print the warning about it).
  let didCleanup = false;
  let projectCreated = false;
  const cleanup = async () => {
    if (didCleanup) return;
    didCleanup = true;
    rmSync(workDir, { recursive: true, force: true });
    if (!projectCreated) return;
    try {
      await glabApi(`projects/${encodeProject(projectPath)}`, ["-X", "DELETE"]);
    } catch {
      console.warn(`  warning: could not delete remote repo ${projectPath} — delete it manually`);
    }
  };
  // Register *before* creating the remote project so a SIGINT during creation
  // still triggers cleanup of the workDir (and of the project once it exists).
  activeCleanup = cleanup;

  await step(`Create GitLab repo: ${repoName}`, async () => {
    const created = (await glabApi("projects", [
      "-X",
      "POST",
      "-f",
      `name=${repoName}`,
      "-f",
      "visibility=private",
      "-f",
      "initialize_with_readme=false",
    ])) as { web_url?: string };
    projectCreated = true;
    if (created.web_url) console.log(`  url:          ${created.web_url}`);
    // Fast-forward-only merges so squash merges land a single commit on main
    // with no merge-commit — that's the shape smart-rebase is designed for.
    await glabApi(`projects/${encodeProject(projectPath)}`, ["-X", "PUT", "-f", "merge_method=ff"]);
  });

  await step("Clone the repo", async () => {
    await $`glab repo clone ${projectPath} ${repoDir}`.quiet();
    await $`git config commit.gpgsign false`.cwd(repoDir).quiet();
  });

  await step("Push initial commit to main", async () => {
    await $`git commit --allow-empty -m "chore: initial commit"`.cwd(repoDir).quiet();
    await $`git push -u origin main`.cwd(repoDir).quiet();
  });

  const ctx: E2EContext = { repoDir, projectPath, entryScript, workDir, scenarioName };
  return { ctx, cleanup };
}

export async function checkout(ctx: E2EContext, branch: string): Promise<void> {
  await $`git checkout ${branch}`.cwd(ctx.repoDir).quiet();
}

export async function createBranchFrom(ctx: E2EContext, name: string, fromRef: string): Promise<void> {
  await $`git checkout -b ${name} ${fromRef}`.cwd(ctx.repoDir).quiet();
}

export interface CommitSpec {
  /** File to write inside the repo. Path is relative to repoDir. */
  file: string;
  content: string;
  message: string;
}

/** Writes each file, stages it, and commits with the given message. */
export async function addCommits(ctx: E2EContext, commits: CommitSpec[]): Promise<void> {
  for (const c of commits) {
    await Bun.write(join(ctx.repoDir, c.file), c.content);
    await $`git add ${c.file}`.cwd(ctx.repoDir).quiet();
    await $`git commit -m ${c.message}`.cwd(ctx.repoDir).quiet();
  }
}

export async function pushBranch(ctx: E2EContext, branch: string): Promise<void> {
  await $`git push -u origin ${branch}`.cwd(ctx.repoDir).quiet();
}

export async function forcePushBranch(ctx: E2EContext, branch: string): Promise<void> {
  await $`git push --force-with-lease origin ${branch}`.cwd(ctx.repoDir).quiet();
}

export async function pullBranch(ctx: E2EContext, branch: string): Promise<void> {
  await checkout(ctx, branch);
  await $`git pull origin ${branch}`.cwd(ctx.repoDir).quiet();
}

export async function createMR(
  ctx: E2EContext,
  opts: { sourceBranch: string; targetBranch: string; title: string; description?: string },
): Promise<number> {
  const mr = (await glabApi(`projects/${encodeProject(ctx.projectPath)}/merge_requests`, [
    "-X",
    "POST",
    "-f",
    `source_branch=${opts.sourceBranch}`,
    "-f",
    `target_branch=${opts.targetBranch}`,
    "-f",
    `title=${opts.title}`,
    "-f",
    `description=${opts.description ?? ""}`,
  ])) as { iid: number };
  return mr.iid;
}

/** Issue a "rebase onto target branch" on the MR — the GitLab equivalent of
 * pressing the "Rebase" button. Polls until the rebase completes. */
export async function gitlabRebaseMR(ctx: E2EContext, iid: number): Promise<void> {
  await glabApi(`projects/${encodeProject(ctx.projectPath)}/merge_requests/${iid}/rebase`, ["-X", "PUT"]);
  // Poll until rebase_in_progress is false. GitLab returns the field on the
  // standard MR endpoint.
  for (let i = 0; i < 30; i++) {
    const mr = (await glabApi(`projects/${encodeProject(ctx.projectPath)}/merge_requests/${iid}`)) as {
      rebase_in_progress?: boolean;
      merge_error?: string | null;
    };
    if (!mr.rebase_in_progress) {
      if (mr.merge_error) throw new Error(`GitLab rebase failed: ${mr.merge_error}`);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for GitLab to rebase MR !${iid}`);
}

export async function mergeMR(ctx: E2EContext, iid: number, opts: { squash?: boolean } = {}): Promise<void> {
  // After a (force-)push, GitLab takes a moment to recompute the MR's
  // merge_status. Calling /merge while it's still "checking" returns 405, and
  // GitLab will transiently report "preparing" or even a stale "conflict"
  // immediately after a force-push, so poll until it settles on "mergeable".
  let lastStatus = "";
  for (let i = 0; i < 4; i++) {
    const mr = (await glabApi(`projects/${encodeProject(ctx.projectPath)}/merge_requests/${iid}`)) as {
      detailed_merge_status?: string;
      merge_status?: string;
    };
    const status = mr.detailed_merge_status ?? mr.merge_status ?? "";
    lastStatus = status;
    if (status === "mergeable" || status === "can_be_merged") break;
    // if (status && !transient.has(status)) {
    //   throw new Error(`MR !${iid} is not mergeable: ${status}`);
    // }
    await Bun.sleep(1000);
  }
  if (lastStatus !== "mergeable" && lastStatus !== "can_be_merged") {
    throw new Error(`Timed out waiting for MR !${iid} to become mergeable (last: ${lastStatus})`);
  }
  await glabApi(`projects/${encodeProject(ctx.projectPath)}/merge_requests/${iid}/merge`, [
    "-X",
    "PUT",
    "-f",
    `squash=${opts.squash !== false}`,
  ]);
}

export async function runGitlabRebase(ctx: E2EContext, args: string[] = []): Promise<void> {
  const result = await $`bun run ${ctx.entryScript} ${args}`.cwd(ctx.repoDir).nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`smart-rebase exited with code ${result.exitCode}`);
  }
}

export async function logOneline(ctx: E2EContext, ref = "HEAD"): Promise<string[]> {
  const out = (await $`git log --oneline -20 ${ref}`.cwd(ctx.repoDir).text()).trim();
  return out ? out.split("\n") : [];
}

export async function printHistory(ctx: E2EContext, ref: string, label: string): Promise<void> {
  const log = await logOneline(ctx, ref);
  console.log(`  ${label}:\n${log.map((l) => `    ${l}`).join("\n")}`);
}

export async function expectCommitCount(ctx: E2EContext, ref: string, expected: number): Promise<void> {
  const count = (await logOneline(ctx, ref)).length;
  if (count !== expected) {
    throw new Error(`Expected ${expected} commits on ${ref}, got ${count}`);
  }
}

export interface Scenario {
  name: string;
  description: string;
  run(ctx: E2EContext): Promise<void>;
}

/** Runs a scenario with full setup/teardown around it. */
export async function runScenario(scenario: Scenario): Promise<boolean> {
  // If SIGINT cleanup is in flight (from this or a previous scenario), don't
  // start any new work. Block forever so the loop can't advance; the SIGINT
  // handler will call process.exit when its cleanup completes.
  if (sigintHandled) await blockUntilExit();

  console.log(`\n${BOLD_BLUE}━━━ ${scenario.name} ━━━${RESET}`);
  console.log(`${DIM}${scenario.description}${RESET}`);
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const setup = await setupScenario(scenario.name);
    cleanup = setup.cleanup;
    await scenario.run(setup.ctx);
    console.log(`\n${GREEN}✓ ${scenario.name} passed${RESET}`);
    return true;
  } catch (e) {
    // SIGINT typically reaches here as a child-process exit-130 rejection.
    // Suppress the misleading "scenario failed" output and let the SIGINT
    // handler drive cleanup + exit.
    if (sigintHandled) await blockUntilExit();
    console.error(`\n${RED}✗ ${scenario.name} failed:${RESET}`);
    console.error(e instanceof Error ? e.message : String(e));
    if (e != null && typeof e === "object") {
      const stderr = "stderr" in e ? String((e as { stderr: unknown }).stderr).trim() : "";
      const stdout = "stdout" in e ? String((e as { stdout: unknown }).stdout).trim() : "";
      if (stderr) console.error(`stderr:\n${stderr}`);
      if (stdout) console.error(`stdout:\n${stdout}`);
    }
    if (e instanceof Error && e.stack) console.error(e.stack);
    return false;
  } finally {
    if (cleanup && !sigintHandled) {
      // Clear the SIGINT-driven cleanup hook before invoking cleanup
      // ourselves. (When sigintHandled is set we never reach here — the catch
      // block above blocks forever — so the SIGINT handler owns cleanup.)
      activeCleanup = null;
      await step("Cleanup", cleanup);
    }
  }
}

function blockUntilExit(): Promise<never> {
  return new Promise<never>(() => {});
}
