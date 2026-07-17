import { createCli, type Argv } from "./cli";
import { getAuth, type GitLabAuth } from "./auth";
import { fetchMergedMRsSince, type MRWithCommits, getGitlabUrl } from "./gitlab";
import { readCache, writeCache, type MrsProjectCache } from "./storage";
import { selectPrompt, withProgress } from "./manual/prompt";
import { pl, plc, q, stderr, stdout } from "./format";
import { typedRegExp } from "ts-regexp";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export async function main(args: string[], opts: { cwd?: string; stdin?: NodeJS.ReadableStream } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const argv = (await createCli(args).parseAsync()) as Argv;

  const auth = await getAuth(opts.stdin);

  await ensureGitRepo(cwd, argv.verbose);

  await checkAndStashDirtyChanges(cwd, opts.stdin);

  const target = determineTargetBranch(argv.target);

  await checkAndUpdateTargetBranch(cwd, target);

  await rebaseUnmergedCommitsOnCurrentBranch(cwd, target, auth, argv.verbose);
}

async function rebaseUnmergedCommitsOnCurrentBranch(
  cwd: string,
  target: string,
  auth: GitLabAuth,
  verbose: boolean,
): Promise<void> {
  const projectId = await getProjectId(cwd);

  const [baseSha, currentBranch, currentBranchCommits, mergedMatcher, targetCommits] = await withProgress(
    `Figuring out which commits to rebase...`,
    async () => {
      const baseSha = await getBaseSha(cwd, target);
      return await Promise.all([
        baseSha,
        getCurrentBranch(cwd),
        getCurrentBranchCommits(cwd, baseSha),
        getMergedCommitMatcher(cwd, baseSha, projectId, target, auth, verbose),
        getCommitsBetween(cwd, baseSha, target),
      ]);
    },
  );

  // Stacked-branch case: when the target branch has its own commits ahead of the
  // merge-base (e.g. a parent feature branch in a stacked-MR setup), treat those
  // commits as "already on target" so we can match them on the current branch
  // and skip them. Match by (author date, title) so a rebased target branch
  // (with new SHAs) still matches the current branch's pre-rebase ancestors.
  for (const c of targetCommits) {
    matcherAdd(mergedMatcher, c.sha, c.authoredDate, c.title);
  }

  if (currentBranchCommits.length === 0) {
    stdout(`No commits on branch ${q(currentBranch)} ahead of ${q(target)}.`);
    return;
  }

  // Re-check current branch; stash/update steps could in principle change it.
  if (currentBranch === target) return;

  // currentBranchCommits is newest-first (git log default). Walk oldest-first
  // so we can reason about "first non-merged commit" naturally.
  const oldestFirst = [...currentBranchCommits].reverse();
  const keepFlags = oldestFirst.map((commit) => !matcherHas(mergedMatcher, commit));
  const willRebaseCount = keepFlags.filter(Boolean).length;
  const alreadyMergedCount = oldestFirst.length - willRebaseCount;

  if (willRebaseCount === 0) {
    const n = alreadyMergedCount;
    stdout(
      `The ${plc(n, "commit")} on branch ${q(currentBranch)} ${pl(n, "has")} already been merged to ${q(target)}.`,
    );
    stdout(`Switching to branch ${q(target)}.`);
    await Bun.$`git checkout ${target}`.cwd(cwd).quiet();
    return;
  }

  const n = alreadyMergedCount;
  stdout(
    [
      `Rebasing ${q(currentBranch)} onto ${q(target)}.`,
      ...(n > 0 ? [` ${plc(n, "commit")} ${pl(n, "has")} already been merged to ${q(target)}.`] : []),
      `Will rebase ${plc(willRebaseCount, "commit")}.`,
    ].join(" "),
  );

  // When every merged commit forms a contiguous prefix (or there are none at
  // all) we can use a plain `git rebase --onto target upstream`. Otherwise we
  // do a single interactive rebase whose todo list has the merged commits'
  // `pick` lines rewritten to `drop` by a sequence editor we control. Either
  // way, smart-rebase invokes git rebase exactly once.
  const firstKeptIdx = keepFlags.findIndex(Boolean);
  const allMergedAtStart = keepFlags.slice(firstKeptIdx).every(Boolean);

  if (allMergedAtStart) {
    const rebaseUpstream = oldestFirst[firstKeptIdx - 1]?.sha ?? baseSha;
    await runRebase(cwd, target, rebaseUpstream, willRebaseCount, [], []);
  } else {
    const dropShas = oldestFirst.filter((_, i) => !keepFlags[i]).map((c) => c.sha);
    const allShas = oldestFirst.map((c) => c.sha);
    await runRebase(cwd, target, baseSha, willRebaseCount, allShas, dropShas);
  }
}

async function runRebase(
  cwd: string,
  target: string,
  upstream: string,
  willRebaseCount: number,
  allShas: string[],
  dropShas: string[],
): Promise<void> {
  let todoDir: string | null = null;
  let rebaseOutput = "";
  try {
    await withProgress(`Rebasing ${plc(willRebaseCount, "commit")} onto ${q(target)}...`, async () => {
      let cmd = Bun.$`git rebase --onto ${target} ${upstream}`.cwd(cwd);
      if (dropShas.length > 0) {
        const todo = await writeRebaseTodo(allShas, dropShas);
        todoDir = todo.dir;
        cmd = Bun.$`git rebase -i --onto ${target} ${upstream}`.cwd(cwd).env({
          ...process.env,
          // Git appends the path of its own todo file as the final argument
          // to GIT_SEQUENCE_EDITOR. Using `cp <ourTodo>` as the "editor"
          // makes git overwrite its todo with the picks/drops we already
          // computed — no editor process, no Bun runtime, no string munging.
          GIT_SEQUENCE_EDITOR: `cp ${todo.path}`,
          // Safety: pick/drop never invoke a per-commit editor, but if
          // anything ever did, don't launch vi.
          GIT_EDITOR: "true",
        });
      }
      const r = await cmd.quiet().nothrow();
      // git rebase uses bare \r to overwrite progress lines. Split on any
      // line ending (\r\n, \r, \n) so Windows output is handled correctly,
      // then drop whitespace-only lines.
      rebaseOutput = (r.stdout.toString() + r.stderr.toString())
        .split(/\r\n|\r|\n/)
        .filter((l) => l.trim())
        .join("\n")
        .replace(/refs\/heads\/(\S+?)([.,!;:]*)(\s|$)/g, (_, branch, punct, end) => q(branch) + punct + end);
      if (r.exitCode !== 0) {
        throw new Error(rebaseOutput);
      }
    });
  } finally {
    if (todoDir) rmSync(todoDir, { recursive: true, force: true });
  }
  if (rebaseOutput) stderr(rebaseOutput);
}

async function writeRebaseTodo(allShas: string[], dropShas: string[]): Promise<{ dir: string; path: string }> {
  const dropSet = new Set(dropShas);
  // git rebase's pick/drop parser only reads the action and the SHA; subjects
  // (the rest of the line) are decorative, so we omit them.
  const lines = allShas.map((sha) => `${dropSet.has(sha) ? "drop" : "pick"} ${sha}`);
  const dir = mkdtempSync("/tmp/smart-rebase-todo-");
  const path = join(dir, "todo");
  await Bun.write(path, lines.join("\n") + "\n");
  return { dir, path };
}

function maxIsoDateString(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Oldest pagination floor for the GitLab MR list: merge-base date, or newer if cache already covers older pages. */
function mergeRequestFetchSince(baseDate: string, cache: MrsProjectCache | null): string {
  if (!cache?.mrs.length) return baseDate;
  const { mergeBaseCommitAt, mrs } = cache;
  if (!mergeBaseCommitAt || new Date(baseDate) < new Date(mergeBaseCommitAt)) {
    return baseDate;
  }
  let newest = mrs[0]!.mr.updated_at;
  for (let i = 1; i < mrs.length; i++) {
    const t = mrs[i]!.mr.updated_at;
    if (new Date(t).getTime() > new Date(newest).getTime()) newest = t;
  }
  return maxIsoDateString(baseDate, newest);
}

interface CommitInfo {
  sha: string;
  authoredDate: string;
  title: string;
}

interface CommitMatcher {
  shas: Set<string>;
  dateTitles: Set<string>;
}

function newMatcher(): CommitMatcher {
  return { shas: new Set(), dateTitles: new Set() };
}

// Match by `${authoredDate} ${title}` so a rebased copy of a commit (new SHA,
// same author identity and message) is recognised as the "same" commit.
// Dates are normalised to UTC ISO before comparison because GitLab and local
// git emit different but equivalent representations of the same instant
// (e.g. `2026-05-27T22:11:02+02:00` vs `2026-05-27T20:11:02.000Z`).
function normalizeDate(authoredDate: string | undefined): string | undefined {
  if (!authoredDate) return undefined;
  const ms = Date.parse(authoredDate);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function matcherAdd(m: CommitMatcher, sha: string, authoredDate: string | undefined, title: string): void {
  m.shas.add(sha);
  const normalized = normalizeDate(authoredDate);
  if (normalized) m.dateTitles.add(`${normalized} ${title}`);
}

function matcherHas(m: CommitMatcher, c: CommitInfo): boolean {
  if (m.shas.has(c.sha)) return true;
  const normalized = normalizeDate(c.authoredDate);
  return normalized !== undefined && m.dateTitles.has(`${normalized} ${c.title}`);
}

async function getMergedCommitMatcher(
  cwd: string,
  baseSha: string,
  projectId: string,
  target: string,
  auth: GitLabAuth,
  verbose: boolean,
): Promise<CommitMatcher> {
  const mrs = await fetchMergedMRsForMatching(cwd, baseSha, projectId, target, auth, verbose);
  const matcher = newMatcher();
  for (const { commits } of mrs) {
    for (const c of commits) matcherAdd(matcher, c.id, c.authored_date, c.title);
  }
  return matcher;
}

async function fetchMergedMRsForMatching(
  cwd: string,
  baseSha: string,
  projectId: string,
  target: string,
  auth: GitLabAuth,
  verbose: boolean,
) {
  const [baseDate, cache] = await Promise.all([getBaseCommitDate(cwd, baseSha), readCache(projectId)]);

  const since = mergeRequestFetchSince(baseDate, cache);
  const fresh = await fetchMergedMRsSince({ baseUrl: getGitlabUrl(), projectId, token: auth.token, since });
  const byIid = new Map<number, MRWithCommits>();
  for (const entry of cache?.mrs ?? []) byIid.set(entry.mr.iid, entry);
  for (const entry of fresh) byIid.set(entry.mr.iid, entry);
  const allMrs = [...byIid.values()].sort((a, b) => b.mr.iid - a.mr.iid);
  await writeCache(projectId, allMrs, baseDate);

  // For matching, consider every merged MR newer than baseDate, regardless of
  // its target_branch. When the user rebases onto a stacked feature branch
  // (target != main), MRs that were merged to main are still relevant — their
  // commits are in main, which is an ancestor of the target.
  const matchingMRs = allMrs.filter(({ mr }) => mr.merged_at !== null && new Date(mr.merged_at) >= new Date(baseDate));
  if (verbose && matchingMRs.length > 0) {
    stderr(`Considering ${matchingMRs.length} MRs for rebasing:`);
    // Verbose listing only shows MRs that landed directly on the target branch,
    // so output stays focused on what the user explicitly asked to rebase onto.
    for (const { mr, commits } of matchingMRs) {
      if (mr.target_branch !== target) continue;
      stderr(`  !${mr.iid} ${mr.title}`);
      for (const commit of commits) {
        stderr(`    ${commit.short_id} ${commit.title}`);
      }
    }
  }
  return matchingMRs;
}

async function checkAndStashDirtyChanges(cwd: string, stdin?: NodeJS.ReadableStream): Promise<void> {
  const result = await withProgress("Checking for uncommitted changes...", () =>
    Bun.$`git diff --quiet HEAD`.cwd(cwd).quiet().nothrow(),
  );
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
    stderr(stashOutput);
  }
}

async function checkAndUpdateTargetBranch(cwd: string, target: string): Promise<void> {
  let upstream: string;
  try {
    upstream = await withProgress("Finding upstream...", async () =>
      (await Bun.$`git rev-parse --abbrev-ref ${target}@{u}`.cwd(cwd).quiet().text()).trim(),
    );
  } catch {
    throw new Error(
      `Branch ${q(target)} isn't tracking an upstream branch. ` +
        `Use something like: ${q(`git branch --set-upstream-to=origin/${target} ${target}`)}`,
    );
  }

  const upstreamMatch = typedRegExp("^(?<remoteName>[^/]+)/(?<remoteBranch>.+)$").matchIn(upstream);
  if (upstreamMatch === null) {
    throw new Error(`Unexpected upstream format: ${upstream}`);
  }
  const { remoteName, remoteBranch } = upstreamMatch.groups;

  const isTargetBranchBehindRemote = await withProgress(`Checking ${q(target)}'s upstream...`, async () => {
    // Fetch to get the real current state of the remote branch.
    await Bun.$`git fetch ${remoteName} ${remoteBranch}`.cwd(cwd).quiet();
    return (await Bun.$`git rev-list ${target}..${upstream}`.cwd(cwd).quiet().text()).trim().length > 0;
  });

  if (!isTargetBranchBehindRemote) {
    return;
  }

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
  stderr(`Branch ${q(target)} updated.`);
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
  const headShort = await withProgress("Checking Git repository...", async () => {
    try {
      return (await Bun.$`git rev-parse --short HEAD`.cwd(cwd).quiet().text()).trim();
    } catch {
      throw new Error(`Not a Git repository. ${q("smart-rebase")} must be used inside a Git repo.`);
    }
  });
  if (verbose) {
    stderr(`Current commit: ${q(headShort)}`);
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

async function getCurrentBranchCommits(cwd: string, baseSha: string): Promise<CommitInfo[]> {
  return logCommitInfos(cwd, `${baseSha}..HEAD`);
}

async function getCommitsBetween(cwd: string, fromSha: string, toRef: string): Promise<CommitInfo[]> {
  return logCommitInfos(cwd, `${fromSha}..${toRef}`);
}

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

async function logCommitInfos(cwd: string, range: string): Promise<CommitInfo[]> {
  const format = `%H${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`;
  const r = await Bun.$`git log ${range} --format=${format}`.cwd(cwd).quiet().nothrow();
  if (r.exitCode !== 0) return [];
  const out = r.stdout.toString();
  return out
    .split(LOG_RECORD_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, authoredDate, title] = rec.split(LOG_FIELD_SEP);
      return { sha: sha!, authoredDate: authoredDate!, title: title ?? "" };
    });
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
    stderr(`Rebasing onto branch ${q("main")}.`);
    return "main";
  }
  return target;
}
