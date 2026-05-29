/**
 * End-to-end scenarios exercised against a real GitLab instance.
 *
 * Each scenario sets up a fresh project, walks through the relevant flow, and
 * asserts on the final state of `main`. Scenarios share helpers from
 * `./helpers.ts` so common operations (creating branches, opening MRs,
 * merging, force-pushing, etc.) only live in one place.
 */

import {
  addCommits,
  checkout,
  createBranchFrom,
  createMR,
  expectCommitCount,
  forcePushBranch,
  gitlabRebaseMR,
  logOneline,
  mergeMR,
  printHistory,
  pullBranch,
  pushBranch,
  runGitlabRebase,
  step,
  type E2EContext,
  type Scenario,
} from "./helpers";

/**
 * Scenario 0 (baseline): the original happy path from the first e2e test.
 *
 * Two stacked feature branches A and B (B sits on top of A). Squash-merge A,
 * then run smart-rebase on B; smart-rebase must recognise A's commits as
 * already merged and rebase only B's own commits onto main.
 */
export const baselineStackedSquash: Scenario = {
  name: "baseline-stacked-squash",
  description: "A then B; A is squash-merged; smart-rebase on B drops A's commits and rebases B onto main.",
  async run(ctx: E2EContext) {
    await step("Create feature-a with 2 commits", async () => {
      await createBranchFrom(ctx, "feature-a", "main");
      await addCommits(ctx, [
        { file: "feature-a-1.txt", content: "Feature A — file 1\n", message: "feat(a): add first file" },
        { file: "feature-a-2.txt", content: "Feature A — file 2\n", message: "feat(a): add second file" },
      ]);
      await pushBranch(ctx, "feature-a");
    });

    const mrA = await step_(ctx, "Open MR A", () =>
      createMR(ctx, { sourceBranch: "feature-a", targetBranch: "main", title: "MR A: Feature A" }),
    );

    await step("Create feature-b stacked on feature-a with 3 commits", async () => {
      await createBranchFrom(ctx, "feature-b", "feature-a");
      await addCommits(ctx, [
        { file: "feature-b-1.txt", content: "Feature B — file 1\n", message: "feat(b): add first file" },
        { file: "feature-b-2.txt", content: "Feature B — file 2\n", message: "feat(b): add second file" },
        { file: "feature-b-3.txt", content: "Feature B — file 3\n", message: "feat(b): add third file" },
      ]);
      await pushBranch(ctx, "feature-b");
    });

    const mrB = await step_(ctx, "Open MR B", () =>
      createMR(ctx, { sourceBranch: "feature-b", targetBranch: "main", title: "MR B: Feature B" }),
    );

    await step(`Squash-merge MR A (!${mrA})`, () => mergeMR(ctx, mrA, { squash: true }));
    await step("Pull main", () => pullBranch(ctx, "main"));

    await step("Run smart-rebase on feature-b", async () => {
      await checkout(ctx, "feature-b");
      await runGitlabRebase(ctx);
      await printHistory(ctx, "HEAD", "feature-b after rebase");
    });

    await step("Push rebased feature-b and merge MR B", async () => {
      await forcePushBranch(ctx, "feature-b");
      await mergeMR(ctx, mrB, { squash: true });
    });

    await step("Verify main has 3 commits", async () => {
      await pullBranch(ctx, "main");
      await expectCommitCount(ctx, "main", 3);
    });
  },
};

/**
 * Scenario 1: GitLab "rebase A onto main" rewrites A's SHAs.
 *
 * Order of events:
 *   - Create A (2 commits) and B (stacked on A, 2 commits).
 *   - An unrelated MR C is squash-merged to main.
 *   - On A's MR page in GitLab, press "rebase onto main" — A's commits
 *     get new SHAs but the same author dates and titles.
 *   - Merge A. Now A's MR commits in GitLab have brand-new SHAs.
 *   - Locally, B still has the original (pre-rebase) A commits in its history.
 *   - Run smart-rebase on B. It must match the old A-commits on B against
 *     A's new commits via (author date, title) and skip them.
 */
export const sha1RewrittenByGitlabRebase: Scenario = {
  name: "scenario-1-smart-rebase-rewrites-shas",
  description:
    "C lands on main; user clicks 'rebase A onto main' on GitLab (rewriting A's SHAs); A merges. " +
    "smart-rebase on B must match A's old commits by (author date, title), not SHA.",
  async run(ctx: E2EContext) {
    await step("Create feature-a with 2 commits", async () => {
      await createBranchFrom(ctx, "feature-a", "main");
      await addCommits(ctx, [
        { file: "a-1.txt", content: "A1\n", message: "feat(a): a1" },
        { file: "a-2.txt", content: "A2\n", message: "feat(a): a2" },
      ]);
      await pushBranch(ctx, "feature-a");
    });
    const mrA = await createMR(ctx, { sourceBranch: "feature-a", targetBranch: "main", title: "MR A" });

    await step("Create feature-b stacked on feature-a with 2 commits", async () => {
      await createBranchFrom(ctx, "feature-b", "feature-a");
      await addCommits(ctx, [
        { file: "b-1.txt", content: "B1\n", message: "feat(b): b1" },
        { file: "b-2.txt", content: "B2\n", message: "feat(b): b2" },
      ]);
      await pushBranch(ctx, "feature-b");
    });
    const mrB = await createMR(ctx, { sourceBranch: "feature-b", targetBranch: "main", title: "MR B" });

    await step("Create unrelated MR C and squash-merge it to main", async () => {
      await createBranchFrom(ctx, "feature-c", "main");
      await addCommits(ctx, [{ file: "c.txt", content: "C\n", message: "feat(c): add c" }]);
      await pushBranch(ctx, "feature-c");
    });
    const mrC = await createMR(ctx, { sourceBranch: "feature-c", targetBranch: "main", title: "MR C" });
    await step(`Merge MR C (!${mrC})`, () => mergeMR(ctx, mrC, { squash: true }));

    await step("Press 'rebase onto main' on MR A — rewrites A's SHAs", () => gitlabRebaseMR(ctx, mrA));
    await step(`Merge MR A (!${mrA})`, () => mergeMR(ctx, mrA, { squash: false }));

    await step("Run smart-rebase on feature-b (still has pre-rebase A commits)", async () => {
      await checkout(ctx, "feature-b");
      // Local feature-b still has the OLD A commit SHAs as ancestors. After
      // pulling main and rebasing, smart-rebase should detect the old A
      // commits as "already merged" via author-date+title matching.
      await runGitlabRebase(ctx);
      await printHistory(ctx, "HEAD", "feature-b after rebase");
    });

    await step("Push rebased feature-b and merge MR B", async () => {
      await forcePushBranch(ctx, "feature-b");
      await mergeMR(ctx, mrB, { squash: true });
    });

    await step("Verify final main has 4 commits (initial + C + A + B)", async () => {
      await pullBranch(ctx, "main");
      await expectCommitCount(ctx, "main", 4);
    });
  },
};

/**
 * Scenario 2: locally rebasing A leaves B with stale ancestors.
 *
 * Order of events:
 *   - C is merged to main (any unrelated MR).
 *   - User runs `smart-rebase` on A locally → A is now on top of new main
 *     with rewritten SHAs but identical author dates/titles.
 *   - User switches to B and runs `smart-rebase feature-a`. A is *not*
 *     merged, so this is purely a Git problem: B's old A-ancestors must be
 *     matched against feature-a (the local target) by (author date, title).
 */
export const localRebaseTargetMatching: Scenario = {
  name: "scenario-2-local-target-matching",
  description:
    "C is merged; user locally rebases A; running `smart-rebase feature-a` on B must " +
    "match B's stale A-ancestors against the freshly rebased feature-a.",
  async run(ctx: E2EContext) {
    await step("Create feature-a (2 commits) and feature-b stacked on it (2 commits)", async () => {
      await createBranchFrom(ctx, "feature-a", "main");
      await addCommits(ctx, [
        { file: "a-1.txt", content: "A1\n", message: "feat(a): a1" },
        { file: "a-2.txt", content: "A2\n", message: "feat(a): a2" },
      ]);
      await pushBranch(ctx, "feature-a");

      await createBranchFrom(ctx, "feature-b", "feature-a");
      await addCommits(ctx, [
        { file: "b-1.txt", content: "B1\n", message: "feat(b): b1" },
        { file: "b-2.txt", content: "B2\n", message: "feat(b): b2" },
      ]);
      await pushBranch(ctx, "feature-b");
    });

    await step("Create unrelated MR C and squash-merge it to main", async () => {
      await createBranchFrom(ctx, "feature-c", "main");
      await addCommits(ctx, [{ file: "c.txt", content: "C\n", message: "feat(c): add c" }]);
      await pushBranch(ctx, "feature-c");
    });
    const mrC = await createMR(ctx, { sourceBranch: "feature-c", targetBranch: "main", title: "MR C" });
    await step(`Merge MR C (!${mrC})`, () => mergeMR(ctx, mrC, { squash: true }));

    await step("Locally rebase feature-a onto new main with smart-rebase", async () => {
      await pullBranch(ctx, "main");
      await checkout(ctx, "feature-a");
      await runGitlabRebase(ctx);
      await printHistory(ctx, "HEAD", "feature-a after rebase");
    });

    await step("Switch to feature-b, run `smart-rebase feature-a`", async () => {
      await checkout(ctx, "feature-b");
      // feature-b still has the OLD a1/a2 as ancestors. With target-branch
      // matching, those are recognised as "already in feature-a" via
      // (author date, title) and only b1/b2 get cherry-picked onto feature-a.
      await runGitlabRebase(ctx, ["feature-a"]);
      await printHistory(ctx, "HEAD", "feature-b after rebase onto feature-a");
    });

    await step("Verify feature-b is exactly feature-a + 2 commits", async () => {
      const aTip = (await Bun.$`git rev-parse feature-a`.cwd(ctx.repoDir).text()).trim();
      const bGrandparent = (await Bun.$`git rev-parse HEAD~2`.cwd(ctx.repoDir).text()).trim();
      if (aTip !== bGrandparent) {
        throw new Error(`feature-b should be feature-a + 2 commits; got grandparent ${bGrandparent} vs ${aTip}`);
      }
      const log = await logOneline(ctx, "feature-a..HEAD");
      if (log.length !== 2) throw new Error(`Expected 2 commits ahead of feature-a, got ${log.length}`);
    });
  },
};

/**
 * Scenario 3: combined GitLab + local matching.
 *
 * A variant of scenario 2 where C is the local ancestor of A (so A's local
 * history contains C's commits). After C is squash-merged and A is locally
 * rebased, running `smart-rebase feature-a` on B must use *both*:
 *   - GitLab merged-MR matching to recognise C's old commits in B's history.
 *   - Local target-branch matching to recognise A's old commits in B's history.
 */
export const combinedGitlabAndLocalMatching: Scenario = {
  name: "scenario-3-combined-matching",
  description:
    "C is a local ancestor of A; squash-merge C; locally rebase A; " +
    "`smart-rebase feature-a` on B must combine GitLab MR matching (for C) and local target matching (for A).",
  async run(ctx: E2EContext) {
    await step(
      "Create feature-c (1 commit), feature-a stacked (2 commits), feature-b stacked (2 commits)",
      async () => {
        await createBranchFrom(ctx, "feature-c", "main");
        await addCommits(ctx, [{ file: "c.txt", content: "C\n", message: "feat(c): add c" }]);
        await pushBranch(ctx, "feature-c");

        await createBranchFrom(ctx, "feature-a", "feature-c");
        await addCommits(ctx, [
          { file: "a-1.txt", content: "A1\n", message: "feat(a): a1" },
          { file: "a-2.txt", content: "A2\n", message: "feat(a): a2" },
        ]);
        await pushBranch(ctx, "feature-a");

        await createBranchFrom(ctx, "feature-b", "feature-a");
        await addCommits(ctx, [
          { file: "b-1.txt", content: "B1\n", message: "feat(b): b1" },
          { file: "b-2.txt", content: "B2\n", message: "feat(b): b2" },
        ]);
        await pushBranch(ctx, "feature-b");
      },
    );

    const mrC = await createMR(ctx, { sourceBranch: "feature-c", targetBranch: "main", title: "MR C" });
    await step(`Squash-merge MR C (!${mrC})`, () => mergeMR(ctx, mrC, { squash: true }));

    await step("Pull main, locally rebase feature-a (drops C's commits)", async () => {
      await pullBranch(ctx, "main");
      await checkout(ctx, "feature-a");
      await runGitlabRebase(ctx);
      await printHistory(ctx, "HEAD", "feature-a after rebase");
    });

    await step("Switch to feature-b, run `smart-rebase feature-a`", async () => {
      await checkout(ctx, "feature-b");
      // feature-b still has [c, a1, a2, b1, b2]. We expect:
      //   - c   → matched via GitLab merged MR (squashed C)
      //   - a1  → matched via local feature-a (rebased a1)
      //   - a2  → matched via local feature-a (rebased a2)
      //   - b1, b2 → cherry-picked onto feature-a.
      await runGitlabRebase(ctx, ["feature-a"]);
      await printHistory(ctx, "HEAD", "feature-b after rebase onto feature-a");
    });

    await step("Verify feature-b sits on top of feature-a with exactly 2 commits", async () => {
      const log = await logOneline(ctx, "feature-a..HEAD");
      if (log.length !== 2) throw new Error(`Expected 2 commits ahead of feature-a, got ${log.length}`);
    });
  },
};

/**
 * Scenario 4: B is squash-merged to main from the middle of the A → B → C stack.
 *
 * To squash-merge B to main *without* including A's changes, the user must
 * first locally rebase feature-b onto main (so B carries only its own
 * commits, with new SHAs but the same author dates and titles), force-push,
 * and then merge. After that:
 *   - main has B's squash commit;
 *   - feature-c still has the original A1, A2, B1, B2, C1, C2 in its history;
 *   - GitLab's MR for B lists the rebased B SHAs — none of which exist on
 *     feature-c.
 * Running `smart-rebase` on feature-c must therefore match B's commits via
 * (author date, title), drop them from the middle of the branch, and rebase
 * A1, A2, C1, C2 onto main.
 */
export const middleOfStackSquashMerge: Scenario = {
  name: "scenario-4-middle-of-stack-squash",
  description:
    "Stack A → B → C; B is locally rebased onto main and then squash-merged. " +
    "smart-rebase on C must drop B's commits from the middle (matched by author-date+title) " +
    "and rebase A's and C's commits onto main.",
  async run(ctx: E2EContext) {
    await step("Create feature-a (2 commits)", async () => {
      await createBranchFrom(ctx, "feature-a", "main");
      await addCommits(ctx, [
        { file: "a-1.txt", content: "A1\n", message: "feat(a): a1" },
        { file: "a-2.txt", content: "A2\n", message: "feat(a): a2" },
      ]);
      await pushBranch(ctx, "feature-a");
    });

    await step("Create feature-b stacked on feature-a (2 commits)", async () => {
      await createBranchFrom(ctx, "feature-b", "feature-a");
      await addCommits(ctx, [
        { file: "b-1.txt", content: "B1\n", message: "feat(b): b1" },
        { file: "b-2.txt", content: "B2\n", message: "feat(b): b2" },
      ]);
      await pushBranch(ctx, "feature-b");
    });
    const mrB = await createMR(ctx, { sourceBranch: "feature-b", targetBranch: "main", title: "MR B" });

    await step("Create feature-c stacked on feature-b (2 commits)", async () => {
      await createBranchFrom(ctx, "feature-c", "feature-b");
      await addCommits(ctx, [
        { file: "c-1.txt", content: "C1\n", message: "feat(c): c1" },
        { file: "c-2.txt", content: "C2\n", message: "feat(c): c2" },
      ]);
      await pushBranch(ctx, "feature-c");
    });

    await step("Locally rebase feature-b onto main (drop A's commits)", async () => {
      await checkout(ctx, "feature-b");
      // Take only B's last 2 commits and replay them on top of main. The
      // resulting feature-b has the same titles and author dates as before
      // but new SHAs, which is exactly what GitLab will record on the MR.
      await Bun.$`git rebase --onto main HEAD~2`.cwd(ctx.repoDir).quiet();
      await forcePushBranch(ctx, "feature-b");
    });

    await step(`Squash-merge MR B (!${mrB}) into main`, () => mergeMR(ctx, mrB, { squash: true }));

    await step("Run smart-rebase on feature-c (drops B's commits from the middle)", async () => {
      await pullBranch(ctx, "main");
      await checkout(ctx, "feature-c");
      await runGitlabRebase(ctx);
      await printHistory(ctx, "HEAD", "feature-c after rebase");
    });

    await step("Verify feature-c contains A1, A2, C1, C2 ahead of main", async () => {
      const messages = (await Bun.$`git log --format=%s main..HEAD`.cwd(ctx.repoDir).text()).trim().split("\n");
      const expected = ["feat(c): c2", "feat(c): c1", "feat(a): a2", "feat(a): a1"];
      if (JSON.stringify(messages) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(messages)}`);
      }
    });
  },
};

export const allScenarios: Scenario[] = [
  baselineStackedSquash,
  sha1RewrittenByGitlabRebase,
  localRebaseTargetMatching,
  combinedGitlabAndLocalMatching,
  middleOfStackSquashMerge,
];

/** Wraps a setup-side helper that returns a value into a `step`. */
async function step_<T>(_ctx: E2EContext, name: string, fn: () => Promise<T>): Promise<T> {
  let result!: T;
  await step(name, async () => {
    result = await fn();
  });
  return result;
}
