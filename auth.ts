import { createInterface } from "node:readline";

export const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

export interface GitLabAuth {
  username: string;
  token: string;
}

export interface AuthOptions {
  env?: Record<string, string | undefined>;
  prompt?: (question: string) => Promise<string>;
  openBrowser?: (url: string) => Promise<void>;
  write?: (message: string) => void;
}

export async function getAuth(options: AuthOptions = {}): Promise<GitLabAuth> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const write = options.write ?? ((msg: string) => process.stderr.write(msg));
  const prompt = options.prompt ?? createReadlinePrompt();
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;

  const username =
    env["GITLAB_USERNAME"] ?? (await promptForUsername({ write, prompt }));
  const token =
    env["GITLAB_TOKEN"] ?? (await promptForToken({ write, prompt, openBrowser }));

  return { username, token };
}

async function promptForUsername(deps: {
  write: (msg: string) => void;
  prompt: (q: string) => Promise<string>;
}): Promise<string> {
  deps.write("GITLAB_USERNAME is not set.\n");
  return (await deps.prompt("Enter your GitLab username: ")).trim();
}

async function promptForToken(deps: {
  write: (msg: string) => void;
  prompt: (q: string) => Promise<string>;
  openBrowser: (url: string) => Promise<void>;
}): Promise<string> {
  deps.write("GITLAB_TOKEN is not set.\n");
  deps.write(
    `Create a personal access token with 'api' scope at:\n  ${GITLAB_TOKEN_URL}\n\n`
  );

  const input = await deps.prompt(
    "Press Enter to open in your browser, or paste your token: "
  );

  if (input.trim() === "") {
    await deps.openBrowser(GITLAB_TOKEN_URL);
    return (await deps.prompt("Enter your GitLab API token: ")).trim();
  }

  return input.trim();
}

function createReadlinePrompt(): (question: string) => Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });

  const iter = rl[Symbol.asyncIterator]();

  return async (question: string): Promise<string> => {
    process.stderr.write(question);
    const result = await iter.next();
    return result.done ? "" : result.value;
  };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    await Bun.$`${cmd} ${url}`.quiet();
  } catch {
    // Ignore if browser can't be opened
  }
}
