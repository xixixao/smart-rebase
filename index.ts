import { createCli } from "./cli";
import { getAuth } from "./auth";
import { fetchMergedMRsSince, type MRWithCommits } from "./gitlab";
import { readCache, writeCache } from "./storage";

export async function main(
  args: string[],
  opts: { cwd?: string; stdinLines?: AsyncIterator<string> } = {}
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const argv = await createCli(args).parseAsync();

  await ensureGitRepo(cwd);

  const target = argv.target ?? "main";

  if (argv.verbose) {
    console.log("Verbose mode enabled");
  }

  if (argv.sha) {
    const headSha = await Bun.$`git rev-parse --short HEAD`.cwd(cwd).text();
    console.log(headSha.trim());
  }

  const auth = await getAuth(opts.stdinLines);

  const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";
  const projectId = await getProjectId(cwd);

  const baseSha = await getBaseSha(cwd, target);
  const [baseDate, targetShas, currentBranch, currentBranchShas, cached] = await Promise.all([
    getBaseCommitDate(cwd, baseSha),
    getTargetShas(cwd, baseSha, target),
    getCurrentBranch(cwd),
    getCurrentBranchShas(cwd, baseSha),
    readCache(gitlabUrl, projectId),
  ]);

  const fresh = await fetchMergedMRsSince({
    baseUrl: gitlabUrl,
    projectId,
    token: auth.token,
    since: baseDate,
  });

  const byIid = new Map<number, MRWithCommits>();
  for (const entry of cached ?? []) byIid.set(entry.mr.iid, entry);
  for (const entry of fresh) byIid.set(entry.mr.iid, entry);
  const allMrs = [...byIid.values()].sort((a, b) => b.mr.iid - a.mr.iid);

  await writeCache(gitlabUrl, projectId, allMrs);

  const sinceDate = new Date(baseDate);
  const mrsWithCommits = allMrs.filter(
    ({ mr, commits }) =>
      mr.merged_at !== null &&
      new Date(mr.merged_at) >= sinceDate &&
      ((mr.merge_commit_sha !== null && targetShas.has(mr.merge_commit_sha)) ||
        commits.some((c) => targetShas.has(c.id)))
  );

  if (currentBranchShas.length === 0) {
    throw new Error(
      `No commits on ${currentBranch} ahead of ${target}.`
    );
  }

  const mergedCommitIds = new Set<string>();
  for (const { commits } of mrsWithCommits) {
    for (const commit of commits) mergedCommitIds.add(commit.id);
  }
  const alreadyMergedCount = currentBranchShas.filter((sha) => mergedCommitIds.has(sha)).length;
  const willRebaseCount = currentBranchShas.length - alreadyMergedCount;

  if (willRebaseCount === 0) {
    throw new Error(
      `All ${alreadyMergedCount} ${alreadyMergedCount === 1 ? "commit" : "commits"} on ${currentBranch} ${alreadyMergedCount === 1 ? "has" : "have"} already been merged to ${target}.`
    );
  }

  const mergedStr = `${alreadyMergedCount} ${alreadyMergedCount === 1 ? "commit" : "commits"}`;
  const willRebaseStr = `${willRebaseCount} ${willRebaseCount === 1 ? "commit" : "commits"}`;
  console.log(
    `Rebasing ${currentBranch} onto ${target}. ${mergedStr} have already been merged to ${target}. Will rebase ${willRebaseStr}.`
  );

  for (const { mr, commits } of mrsWithCommits) {
    console.log(`!${mr.iid} ${mr.title}`);
    for (const commit of commits) {
      console.log(`  ${commit.short_id} ${commit.title}`);
    }
  }
}

async function getProjectId(cwd: string): Promise<string> {
  if (process.env.GITLAB_PROJECT) {
    return process.env.GITLAB_PROJECT;
  }
  const remoteUrl = await resolveGitLabRemoteUrl(cwd);
  if (remoteUrl !== null) {
    const match = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  throw new Error(
    "Cannot determine GitLab project. Set GITLAB_PROJECT or configure a GitLab remote."
  );
}

async function ensureGitRepo(cwd: string): Promise<void> {
  try {
    await Bun.$`git rev-parse --git-dir`.cwd(cwd).quiet();
  } catch {
    throw new Error("Not a git repository. gitlab-rebase must be run inside a git repo.");
  }
}

async function getBaseSha(cwd: string, target: string): Promise<string> {
  try {
    return (await Bun.$`git merge-base HEAD ${target}`.cwd(cwd).quiet().text()).trim();
  } catch {
    throw new Error(
      `Cannot find merge base with branch "${target}". Make sure the branch exists and has commits in common with HEAD.`
    );
  }
}

async function getBaseCommitDate(cwd: string, baseSha: string): Promise<string> {
  return (await Bun.$`git log -1 --format=%cI ${baseSha}`.cwd(cwd).quiet().text()).trim();
}

async function getTargetShas(cwd: string, baseSha: string, target: string): Promise<Set<string>> {
  const out = (
    await Bun.$`git log ${baseSha}..${target} --format=%H`.cwd(cwd).quiet().text()
  ).trim();
  if (!out) return new Set();
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

async function getCurrentBranch(cwd: string): Promise<string> {
  return (await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(cwd).quiet().text()).trim();
}

async function getCurrentBranchShas(cwd: string, baseSha: string): Promise<string[]> {
  const out = (await Bun.$`git log ${baseSha}..HEAD --format=%H`.cwd(cwd).quiet().text()).trim();
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function resolveGitLabRemoteUrl(cwd: string): Promise<string | null> {
  const output = (await Bun.$`git remote`.cwd(cwd).quiet().text()).trim();
  const remotes = output ? output.split("\n").map((r) => r.trim()).filter(Boolean) : [];

  let remoteName: string;
  if (remotes.includes("origin")) {
    remoteName = "origin";
  } else if (remotes.length === 1) {
    remoteName = remotes[0];
  } else {
    return null;
  }

  return (await Bun.$`git remote get-url ${remoteName}`.cwd(cwd).quiet().text()).trim();
}
