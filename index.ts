import { createCli } from "./cli";
import { getAuth } from "./auth";
import { fetchRecentMergedMRs, type MRWithCommits } from "./gitlab";
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

  const mergedAfter = await getBaseCommitDate(cwd, target);

  const [fresh, cached] = await Promise.all([
    fetchRecentMergedMRs({ baseUrl: gitlabUrl, projectId, token: auth.token, mergedAfter }),
    readCache(gitlabUrl, projectId),
  ]);

  const byIid = new Map<number, MRWithCommits>();
  for (const entry of cached ?? []) byIid.set(entry.mr.iid, entry);
  for (const entry of fresh) byIid.set(entry.mr.iid, entry);
  const mrsWithCommits = [...byIid.values()].sort((a, b) => b.mr.iid - a.mr.iid);

  await writeCache(gitlabUrl, projectId, mrsWithCommits);

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

async function getBaseCommitDate(cwd: string, target: string): Promise<string> {
  let baseSha: string;
  try {
    baseSha = (await Bun.$`git merge-base HEAD ${target}`.cwd(cwd).quiet().text()).trim();
  } catch {
    throw new Error(
      `Cannot find merge base with branch "${target}". Make sure the branch exists and has commits in common with HEAD.`
    );
  }
  return (await Bun.$`git log -1 --format=%cI ${baseSha}`.cwd(cwd).quiet().text()).trim();
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

