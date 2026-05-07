/**
 * Shared helpers for the gitlab-rebase end-to-end tests.
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

export function isInteractive(): boolean {
  return process.argv.includes("--interactive");
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve, reject) => {
    const onSigint = () => {
      rl.close();
      reject(new Error("Interrupted"));
    };
    process.once("SIGINT", onSigint);
    rl.question("", () => {
      process.removeListener("SIGINT", onSigint);
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
  /** Path to gitlab-rebase's entry.ts so each scenario invokes the same binary. */
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
  const repoName = `gitlab-rebase-e2e-${scenarioName}-${Date.now()}`;
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "gitlab-rebase-e2e-")));
  const repoDir = join(workDir, repoName);
  const entryScript = join(import.meta.dir, "..", "..", "src", "manual", "entry.ts");

  const user = (await glabApi("user")) as { username: string };
  const namespace = user.username;
  const projectPath = `${namespace}/${repoName}`;

  console.log(`  user:         ${namespace}`);
  console.log(`  project:      ${projectPath}`);
  console.log(`  work dir:     ${workDir}`);

  await step(`Create GitLab repo: ${repoName}`, async () => {
    await glabApi("projects", [
      "-X",
      "POST",
      "-f",
      `name=${repoName}`,
      "-f",
      "visibility=private",
      "-f",
      "initialize_with_readme=false",
    ]);
    // Fast-forward-only merges so squash merges land a single commit on main
    // with no merge-commit — that's the shape gitlab-rebase is designed for.
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
  const cleanup = async () => {
    rmSync(workDir, { recursive: true, force: true });
    try {
      await glabApi(`projects/${encodeProject(projectPath)}`, ["-X", "DELETE"]);
    } catch {
      console.warn(`  warning: could not delete remote repo ${projectPath} — delete it manually`);
    }
  };
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
    throw new Error(`gitlab-rebase exited with code ${result.exitCode}`);
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
    if (cleanup) {
      await step("Cleanup", cleanup);
    }
  }
}
