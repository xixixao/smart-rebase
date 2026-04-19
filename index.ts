import { createCli } from "./cli";
import { getAuth } from "./auth";
import { fetchRecentMergedMRs } from "./gitlab";

const argv = await createCli().parseAsync();

if (argv.verbose) {
  console.log("Verbose mode enabled");
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
  try {
    const remoteUrl = (await Bun.$`git remote get-url origin`.quiet().text()).trim();
    const match = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  throw new Error(
    "Cannot determine GitLab project. Set GITLAB_PROJECT or configure a GitLab remote named 'origin'."
  );
}
