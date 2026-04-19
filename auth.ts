import { createInterface } from "node:readline";

export const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

export interface GitLabAuth {
  username: string;
  token: string;
}

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
const stdinLines = rl[Symbol.asyncIterator]();

async function prompt(question: string): Promise<string> {
  process.stderr.write(question);
  const result = await stdinLines.next();
  return result.done ? "" : result.value.trim();
}

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.env.BROWSER ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
  try {
    await Bun.$`${cmd} ${url}`.quiet();
  } catch {}
}

export async function getAuth(): Promise<GitLabAuth> {
  let username = process.env.GITLAB_USERNAME;
  if (!username) {
    process.stderr.write("GITLAB_USERNAME is not set.\n");
    username = await prompt("Enter your GitLab username: ");
  }

  let token = process.env.GITLAB_TOKEN;
  if (!token) {
    process.stderr.write("GITLAB_TOKEN is not set.\n");
    process.stderr.write(`Create a personal access token with 'api' scope at:\n  ${GITLAB_TOKEN_URL}\n\n`);
    token = await prompt("Press Enter to open in your browser, or paste your token: ");
    if (token === "") {
      await openBrowser(GITLAB_TOKEN_URL);
      token = await prompt("Enter your GitLab API token: ");
    }
  }

  return { username, token };
}
