import { createCli } from "./cli";
import { getAuth } from "./auth";
import { fetchRecentMergedMRs } from "./gitlab";

const argv = await createCli().parseAsync();

if (argv.verbose) {
  console.log("Verbose mode enabled");
}

if (argv.sha) {
  const headSha = await Bun.$`git rev-parse --short HEAD`.text();
  console.log(headSha.trim());
}

const auth = await getAuth();

const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";
const projectId = await getProjectId();

const mrsWithCommits = await fetchRecentMergedMRs({
  baseUrl: gitlabUrl,
  projectId,
  token: auth.token,
});

for (const { mr, commits } of mrsWithCommits) {
  console.log(`!${mr.iid} ${mr.title}`);
  for (const commit of commits) {
    console.log(`  ${commit.short_id} ${commit.title}`);
  }
}

async function getProjectId(): Promise<string> {
  if (process.env.GITLAB_PROJECT) {
    return process.env.GITLAB_PROJECT;
  }
  const remoteUrl = await resolveGitLabRemoteUrl();
  if (remoteUrl !== null) {
    const match = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  throw new Error(
    "Cannot determine GitLab project. Set GITLAB_PROJECT or configure a GitLab remote."
  );
}

async function resolveGitLabRemoteUrl(): Promise<string | null> {
  let output: string;
  try {
    output = (await Bun.$`git remote`.quiet().text()).trim();
  } catch {
    return null;
  }
  const remotes = output ? output.split("\n").map((r) => r.trim()).filter(Boolean) : [];

  let remoteName: string;
  if (remotes.includes("origin")) {
    remoteName = "origin";
  } else if (remotes.length === 1) {
    remoteName = remotes[0];
  } else {
    return null;
  }

  try {
    return (await Bun.$`git remote get-url ${remoteName}`.quiet().text()).trim();
  } catch {
    return null;
  }
}
