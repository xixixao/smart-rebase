#!/usr/bin/env bun

/**
 * End-to-end test for gitlab-rebase.
 *
 * Run with --interactive to pause before each step and require Enter.
 *
 * Prerequisites:
 *   - glab authenticated (glab auth login)
 *   - GITLAB_TOKEN env var set (for gitlab-rebase itself)
 */

import { $ } from "bun";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const interactive = process.argv.includes("--interactive");

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n\x1b[1;34m▶ ${name}\x1b[0m\n`);
  if (interactive) {
    process.stdout.write("\x1b[2m  Press Enter to run...\x1b[0m");
    await waitForEnter();
  }
  await fn();
  process.stdout.write(`\x1b[32m  ✓ done\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** URL-encodes a GitLab project path for use in API endpoints. */
function encodeProject(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Calls the GitLab API via glab and returns parsed JSON.
 * method defaults to GET; use -X POST/PUT/DELETE in extraArgs for mutations.
 */
async function glabApi(
  endpoint: string,
  extraArgs: string[] = [],
): Promise<unknown> {
  const result = await $`glab api ${endpoint} ${extraArgs}`.quiet();
  const text = result.stdout.toString().trim();
  if (!text) return null;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const repoName = `gitlab-rebase-e2e-${Date.now()}`;
const workDir = mkdtempSync(join(tmpdir(), "gitlab-rebase-e2e-"));
const repoDir = join(workDir, repoName);

let namespace = "";
let projectPath = ""; // namespace/repoName
let mrAIid = 0;
let mrBIid = 0;

const entryScript = join(import.meta.dir, "..", "..", "src", "manual", "entry.ts");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\x1b[1mGitLab Rebase — E2E Test\x1b[0m`);
console.log(`  repo:     ${repoName}`);
console.log(`  work dir: ${workDir}`);
if (interactive) console.log(`  mode:     interactive (confirm each step)`);

try {
  // 1. Identify the authenticated user so we know the namespace.
  await step("Get authenticated GitLab user", async () => {
    const user = (await glabApi("user")) as { username: string };
    namespace = user.username;
    projectPath = `${namespace}/${repoName}`;
    console.log(`  user: ${namespace}`);
  });

  // 2. Create a private GitLab repository.
  await step(`Create GitLab repo: ${repoName}`, async () => {
    await glabApi("projects", [
      "-X", "POST",
      "-f", `name=${repoName}`,
      "-f", "visibility=private",
      "-f", "initialize_with_readme=false",
    ]);
    console.log(`  created: ${projectPath}`);
  });

  // 3. Enable fast-forward-only merges so that a squash merge lands a single
  //    commit on main with no merge-commit, which is what gitlab-rebase is
  //    designed to handle.
  await step("Enable fast-forward merge method on the repo", async () => {
    await glabApi(`projects/${encodeProject(projectPath)}`, [
      "-X", "PUT",
      "-f", "merge_method=ff",
    ]);
    console.log(`  merge_method set to ff (fast-forward)`);
  });

  // 4. Clone the empty repo locally.
  await step("Clone the repo", async () => {
    await $`glab repo clone ${projectPath} ${repoDir}`.quiet();
    console.log(`  cloned to: ${repoDir}`);
  });

  // 5. Push the initial commit that establishes main.
  await step("Push initial commit to main", async () => {
    await $`git commit --allow-empty -m "chore: initial commit"`.cwd(repoDir).quiet();
    await $`git push -u origin main`.cwd(repoDir).quiet();
    console.log(`  main branch initialised`);
  });

  // 6. Create feature-a with two commits.
  await step("Create branch 'feature-a' with 2 commits", async () => {
    await $`git checkout -b feature-a`.cwd(repoDir).quiet();

    await Bun.write(join(repoDir, "feature-a-1.txt"), "Feature A — file 1\n");
    await $`git add feature-a-1.txt`.cwd(repoDir).quiet();
    await $`git commit -m "feat(a): add first file"`.cwd(repoDir).quiet();

    await Bun.write(join(repoDir, "feature-a-2.txt"), "Feature A — file 2\n");
    await $`git add feature-a-2.txt`.cwd(repoDir).quiet();
    await $`git commit -m "feat(a): add second file"`.cwd(repoDir).quiet();

    await $`git push -u origin feature-a`.cwd(repoDir).quiet();
    console.log(`  pushed feature-a with 2 commits`);
  });

  // 7. Open MR A.
  await step("Create MR A (feature-a → main)", async () => {
    const mr = (await glabApi(
      `projects/${encodeProject(projectPath)}/merge_requests`,
      [
        "-X", "POST",
        "-f", "source_branch=feature-a",
        "-f", "target_branch=main",
        "-f", "title=MR A: Feature A",
        "-f", "description=First feature branch",
      ],
    )) as { iid: number };
    mrAIid = mr.iid;
    console.log(`  MR A: !${mrAIid}`);
  });

  // 8. Create feature-b with three commits (branched from main, not feature-a).
  await step("Create branch 'feature-b' with 3 commits", async () => {
    await $`git checkout main`.cwd(repoDir).quiet();
    await $`git checkout -b feature-b`.cwd(repoDir).quiet();

    await Bun.write(join(repoDir, "feature-b-1.txt"), "Feature B — file 1\n");
    await $`git add feature-b-1.txt`.cwd(repoDir).quiet();
    await $`git commit -m "feat(b): add first file"`.cwd(repoDir).quiet();

    await Bun.write(join(repoDir, "feature-b-2.txt"), "Feature B — file 2\n");
    await $`git add feature-b-2.txt`.cwd(repoDir).quiet();
    await $`git commit -m "feat(b): add second file"`.cwd(repoDir).quiet();

    await Bun.write(join(repoDir, "feature-b-3.txt"), "Feature B — file 3\n");
    await $`git add feature-b-3.txt`.cwd(repoDir).quiet();
    await $`git commit -m "feat(b): add third file"`.cwd(repoDir).quiet();

    await $`git push -u origin feature-b`.cwd(repoDir).quiet();
    console.log(`  pushed feature-b with 3 commits`);
  });

  // 9. Open MR B.
  await step("Create MR B (feature-b → main)", async () => {
    const mr = (await glabApi(
      `projects/${encodeProject(projectPath)}/merge_requests`,
      [
        "-X", "POST",
        "-f", "source_branch=feature-b",
        "-f", "target_branch=main",
        "-f", "title=MR B: Feature B",
        "-f", "description=Second feature branch",
      ],
    )) as { iid: number };
    mrBIid = mr.iid;
    console.log(`  MR B: !${mrBIid}`);
  });

  // 10. Merge MR A with squash. With merge_method=ff this produces a single
  //     squash commit on main (no merge-commit), which is the scenario that
  //     gitlab-rebase must recognise and skip when rebasing feature-b.
  await step(`Merge MR A (!${mrAIid}) — squash, fast-forward`, async () => {
    await glabApi(
      `projects/${encodeProject(projectPath)}/merge_requests/${mrAIid}/merge`,
      ["-X", "PUT", "-f", "squash=true"],
    );
    console.log(`  MR A merged`);
  });

  // 11. Bring local main up to date so gitlab-rebase can compare against it.
  await step("Pull main to get the squashed MR A commit", async () => {
    await $`git checkout main`.cwd(repoDir).quiet();
    await $`git pull origin main`.cwd(repoDir).quiet();
    const log = (await $`git log --oneline -5`.cwd(repoDir).text()).trim();
    console.log(`  main history:\n${log.split("\n").map((l) => `    ${l}`).join("\n")}`);
  });

  // 12. Switch to feature-b so gitlab-rebase operates on it.
  await step("Check out feature-b", async () => {
    await $`git checkout feature-b`.cwd(repoDir).quiet();
    const log = (await $`git log --oneline -6`.cwd(repoDir).text()).trim();
    console.log(`  feature-b history:\n${log.split("\n").map((l) => `    ${l}`).join("\n")}`);
  });

  // 13. Run gitlab-rebase. It fetches merged MRs from GitLab, identifies that
  //     MR A's commits are already in main (as the squash commit), and rebases
  //     only the feature-b commits on top of main.
  await step("Run gitlab-rebase on feature-b", async () => {
    const result = await $`bun run ${entryScript}`.cwd(repoDir).nothrow();
    const output = (result.stdout.toString() + result.stderr.toString()).trim();
    if (output) {
      console.log(output.split("\n").map((l) => `  ${l}`).join("\n"));
    }
    if (result.exitCode !== 0) {
      throw new Error(`gitlab-rebase exited with code ${result.exitCode}`);
    }
  });

  // 14. Force-push feature-b with the rebased history.
  await step("Force-push rebased feature-b", async () => {
    await $`git push --force-with-lease origin feature-b`.cwd(repoDir).quiet();
    const log = (await $`git log --oneline -6`.cwd(repoDir).text()).trim();
    console.log(`  feature-b after rebase:\n${log.split("\n").map((l) => `    ${l}`).join("\n")}`);
  });

  // 15. Merge MR B.
  await step(`Merge MR B (!${mrBIid}) — squash, fast-forward`, async () => {
    await glabApi(
      `projects/${encodeProject(projectPath)}/merge_requests/${mrBIid}/merge`,
      ["-X", "PUT", "-f", "squash=true"],
    );
    console.log(`  MR B merged`);
  });

  // 16. Verify the final state of main.
  await step("Verify final state of main", async () => {
    await $`git checkout main`.cwd(repoDir).quiet();
    await $`git pull origin main`.cwd(repoDir).quiet();
    const log = (await $`git log --oneline`.cwd(repoDir).text()).trim();
    console.log(`  final main history:\n${log.split("\n").map((l) => `    ${l}`).join("\n")}`);

    // Sanity check: main should have exactly 3 commits
    // (initial + squashed MR A + squashed MR B).
    const count = log.split("\n").length;
    if (count !== 3) {
      throw new Error(`Expected 3 commits on main, got ${count}`);
    }
    console.log(`  ✓ main has 3 commits as expected`);
  });

  console.log(`\n\x1b[1;32m✓ E2E test passed!\x1b[0m\n`);
} catch (e) {
  console.error(`\n\x1b[1;31m✗ E2E test failed:\x1b[0m`);
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  // Always clean up, even on failure.
  await step("Cleanup: delete local clone and remote repo", async () => {
    rmSync(workDir, { recursive: true, force: true });
    console.log(`  deleted local directory: ${workDir}`);

    if (projectPath) {
      try {
        await glabApi(`projects/${encodeProject(projectPath)}`, ["-X", "DELETE"]);
        console.log(`  deleted remote repo: ${projectPath}`);
      } catch {
        console.warn(`  warning: could not delete remote repo ${projectPath} — delete it manually`);
      }
    }
  });
}
