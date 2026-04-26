import { createCli, type Argv } from "./cli";
import { getAuth } from "./auth";
import { fetchMergedMRs, type MRWithCommits, getGitlabUrl } from "./gitlab";
import { readCache, writeCache } from "./storage";
import { selectPrompt, withProgress } from "./manual/prompt";
import { q } from "./format";
import { typedRegExp } from "ts-regexp";

export async function main(args: string[], opts: { cwd?: string; stdin?: NodeJS.ReadableStream } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const argv = (await createCli(args).parseAsync()) as Argv;

  const auth = await getAuth(opts.stdin);

  await ensureGitRepo(cwd, argv.verbose);

  await checkAndStashDirtyChanges(cwd, opts.stdin);

  const target = determineTargetBranch(argv.target);

  await checkAndUpdateTargetBranch(cwd, target, opts.stdin);

  const projectId = await getProjectId(cwd);

  const baseSha = await getBaseSha(cwd, target);
  {
    const [baseDate, currentBranch, currentBranchShas, cached] = await Promise.all([
      getCurrentBranch(cwd),
      getCurrentBranchShas(cwd, baseSha),
      readCache(projectId),
    ]);
    // const currentBranchShaSet = new Set(currentBranchShas);

    const fresh = await fetchMergedMRs({ baseUrl: getGitlabUrl(), projectId, token: auth.token, since: baseDate });
    const byIid = new Map<number, MRWithCommits>();
    for (const entry of cached ?? []) byIid.set(entry.mr.iid, entry);
    for (const entry of fresh) byIid.set(entry.mr.iid, entry);
    const allMrs = [...byIid.values()].sort((a, b) => b.mr.iid - a.mr.iid);
    await writeCache(projectId, allMrs);

    // const sinceDate = new Date(baseDate);
    const relevantMRs = allMrs.filter(({ mr }) => mr.merged_at !== null && mr.target_branch === target);
    if (currentBranchShas.length === 0) {
      throw new Error(`No commits on branch ${q(currentBranch)} ahead of ${q(target)}.`);
    }
    if (argv.verbose) {
      for (const { mr, commits } of relevantMRs) {
        console.log(`!${mr.iid} ${mr.title}`);
        for (const commit of commits) {
          console.log(`  ${commit.short_id} ${commit.title}`);
        }
      }
    }
  }

  const mergedCommitIds = new Set<string>();
  for (const { commits } of relevantMRs) {
    for (const commit of commits) mergedCommitIds.add(commit.id);
  }
  const alreadyMergedCount = currentBranchShas.filter((sha) => mergedCommitIds.has(sha)).length;
  const willRebaseCount = currentBranchShas.length - alreadyMergedCount;

  if (willRebaseCount === 0) {
    const n = alreadyMergedCount;
    throw new Error(
      `The ${n} ${n === 1 ? "commit" : "commits"} on branch ${q(
        currentBranch,
      )} ${n === 1 ? "has" : "have"} already been merged to ${q(target)}.`,
    );
  }

  const mergedStr = `${alreadyMergedCount} ${alreadyMergedCount === 1 ? "commit" : "commits"}`;
  const willRebaseStr = `${willRebaseCount} ${willRebaseCount === 1 ? "commit" : "commits"}`;
  console.log(
    `Rebasing ${q(currentBranch)} onto ${q(target)}. ${mergedStr} ${
      alreadyMergedCount === 1 ? "has" : "have"
    } already been merged to ${q(target)}. Will rebase ${willRebaseStr}.`,
  );

  // Re-check current branch; stash/update steps could in principle change it.
  const branchBeforeRebase = await getCurrentBranch(cwd);
  if (branchBeforeRebase !== target) {
    // Find the oldest non-merged commit; everything from its parent onward gets rebased.
    const reversedShas = [...currentBranchShas].reverse();
    const firstNonMergedIdx = reversedShas.findIndex((sha) => !mergedCommitIds.has(sha));
    const rebaseUpstream = firstNonMergedIdx === 0 ? baseSha : reversedShas[firstNonMergedIdx - 1]!;

    let rebaseOutput = "";
    await withProgress(`Rebasing ${willRebaseStr} onto ${q(target)}...`, async () => {
      const r = await Bun.$`git rebase --onto ${target} ${rebaseUpstream}`.cwd(cwd).quiet().nothrow();
      // git rebase uses bare \r to overwrite progress lines. Split on any
      // line ending (\r\n, \r, \n) so Windows output is handled correctly,
      // then drop whitespace-only lines.
      rebaseOutput = (r.stdout.toString() + r.stderr.toString())
        .split(/\r\n|\r|\n/)
        .filter((l) => l.trim())
        .join("\n");
      if (r.exitCode !== 0) {
        throw new Error(rebaseOutput);
      }
    });
    if (rebaseOutput) {
      process.stderr.write(rebaseOutput + "\n");
    }
  }
}

async function checkAndStashDirtyChanges(cwd: string, stdin?: NodeJS.ReadableStream): Promise<void> {
  const result = await Bun.$`git diff --quiet HEAD`.cwd(cwd).quiet().nothrow();
  if (result.exitCode === 0) return;

  const choice = await selectPrompt(
    "You have uncommitted changes.",
    [
      { label: "Stash changes", value: "stash" },
      { label: "Skip", value: "skip" },
    ],
    stdin,
  );
  if (choice === "stash") {
    let stashOutput = "";
    await withProgress("Stashing changes...", async () => {
      const r = await Bun.$`git stash push`.cwd(cwd).quiet();
      stashOutput = (r.stdout.toString() + r.stderr.toString()).trim();
    });
    process.stderr.write(stashOutput + "\n");
  }
}

async function checkAndUpdateTargetBranch(cwd: string, target: string, stdin?: NodeJS.ReadableStream): Promise<void> {
  let upstream: string;
  try {
    upstream = (await Bun.$`git rev-parse --abbrev-ref ${target}@{u}`.cwd(cwd).quiet().text()).trim();
  } catch {
    return;
  }

  const upstreamMatch = typedRegExp("^(?<remoteName>[^/]+)/(?<remoteBranch>.+)$").matchIn(upstream);
  if (upstreamMatch === null) {
    throw new Error(`Unexpected upstream format: ${upstream}`);
  }
  const { remoteName, remoteBranch } = upstreamMatch.groups;

  // Fetch to get the real current state of the remote branch.
  await Bun.$`git fetch ${remoteName} ${remoteBranch}`.cwd(cwd).quiet();

  const behind = (await Bun.$`git rev-list ${target}..${upstream}`.cwd(cwd).quiet().text()).trim();
  if (!behind) return;

  const choice = await selectPrompt(
    `Branch ${q(target)} is not up-to-date.`,
    [
      { label: `Update branch ${q(target)} from remote ${q(remoteName)}`, value: "update" },
      { label: "Skip", value: "skip" },
    ],
    stdin,
  );

  if (choice === "update") {
    // Fast-forward the local branch to the already-fetched tracking ref.
    // merge-base --is-ancestor exits non-zero when local has diverged.
    const ff = await Bun.$`git merge-base --is-ancestor ${target} ${upstream}`.cwd(cwd).quiet().nothrow();
    if (ff.exitCode !== 0) {
      throw new Error(`Cannot update branch ${q(target)}: it has diverged from branch ${q(upstream)}.`);
    }
    await withProgress(`Updating branch ${q(target)} from remote ${q(remoteName)}...`, async () => {
      const currentBranch = (await Bun.$`git branch --show-current`.cwd(cwd).quiet().text()).trim();
      if (currentBranch === target) {
        await Bun.$`git reset --hard ${upstream}`.cwd(cwd).quiet();
      } else {
        await Bun.$`git branch -f ${target} ${upstream}`.cwd(cwd).quiet();
      }
    });
    process.stderr.write(`Branch ${q(target)} updated.\n`);
  }
}

async function getProjectId(cwd: string): Promise<string> {
  if (process.env.GITLAB_PROJECT) {
    return process.env.GITLAB_PROJECT;
  }
  const remoteUrl = await resolveGitLabRemoteUrl(cwd);
  if (remoteUrl !== null) {
    const match = typedRegExp("gitlab\\.com[:/](?<projectId>.+?)(?:\\.git)?$").matchIn(remoteUrl);
    if (match) return match.groups.projectId;
  }
  throw new Error("Cannot determine GitLab project. Set GITLAB_PROJECT or configure a GitLab remote.");
}

async function ensureGitRepo(cwd: string, verbose: boolean): Promise<void> {
  try {
    const headShort = (await Bun.$`git rev-parse --short HEAD`.cwd(cwd).quiet().text()).trim();
    if (verbose) {
      console.log(`Current commit: ${q(headShort)}`);
    }
  } catch {
    throw new Error(`Not a Git repository. ${q("gitlab-rebase")} must be used inside a Git repo.`);
  }
}

async function getBaseSha(cwd: string, target: string): Promise<string> {
  try {
    return (await Bun.$`git merge-base HEAD ${target}`.cwd(cwd).quiet().text()).trim();
  } catch {
    throw new Error(
      `Cannot find merge base with branch ${q(
        target,
      )}. Make sure the branch exists and has commits in common with HEAD.`,
    );
  }
}

async function getBaseCommitDate(cwd: string, baseSha: string): Promise<string> {
  return (await Bun.$`git log -1 --format=%cI ${baseSha}`.cwd(cwd).quiet().text()).trim();
}

async function getCurrentBranch(cwd: string): Promise<string> {
  return (await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(cwd).quiet().text()).trim();
}

async function getCurrentBranchShas(cwd: string, baseSha: string): Promise<string[]> {
  const out = (await Bun.$`git log ${baseSha}..HEAD --format=%H`.cwd(cwd).quiet().text()).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function resolveGitLabRemoteUrl(cwd: string): Promise<string | null> {
  const output = (await Bun.$`git remote`.cwd(cwd).quiet().text()).trim();
  const remotes = output
    ? output
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];

  let remoteName: string;
  if (remotes.includes("origin")) {
    remoteName = "origin";
  } else if (remotes.length === 1) {
    remoteName = remotes[0]!;
  } else {
    return null;
  }

  return (await Bun.$`git remote get-url ${remoteName}`.cwd(cwd).quiet().text()).trim();
}

function determineTargetBranch(target?: string): string {
  if (!target) {
    console.log(`Rebasing onto branch ${q("main")}.`);
    return "main";
  }
  return target;
}
