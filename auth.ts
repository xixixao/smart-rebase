import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

export interface GitLabAuth {
  username: string;
  token: string;
}

let _defaultStdinLines: AsyncIterator<string> | undefined;

function getDefaultStdinLines(): AsyncIterator<string> {
  if (!_defaultStdinLines) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    _defaultStdinLines = rl[Symbol.asyncIterator]();
  }
  return _defaultStdinLines;
}

function openBrowser(url: string): Promise<void> {
  const cmd =
    process.env.BROWSER ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
  return Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }).exited.then(() => {});
}

function getSettingsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configHome = process.env.XDG_CONFIG_HOME ?? process.env.APPDATA ?? join(home, ".config");
  return join(configHome, "gitlab-rebase", "credentials.json");
}

async function loadSettings(): Promise<Partial<GitLabAuth>> {
  const file = Bun.file(getSettingsPath());
  if (!(await file.exists())) return {};
  const data = await file.json().catch(() => null) as Record<string, unknown> | null;
  if (data === null) return {};
  return {
    username: typeof data.username === "string" ? data.username : undefined,
    token: typeof data.token === "string" ? data.token : undefined,
  };
}

async function saveSettings(auth: GitLabAuth): Promise<string | null> {
  const settingsPath = getSettingsPath();
  return mkdir(dirname(settingsPath), { recursive: true })
    .then(() => Bun.write(settingsPath, JSON.stringify(auth, null, 2)))
    .then(() => settingsPath)
    .catch(() => null);
}

export async function getAuth(stdinLines?: AsyncIterator<string>): Promise<GitLabAuth> {
  const lines = stdinLines ?? getDefaultStdinLines();

  async function prompt(question: string): Promise<string> {
    process.stderr.write(question);
    const result = await lines.next();
    return result.done ? "" : result.value.trim();
  }

  const saved = await loadSettings();

  let username = process.env.GITLAB_USERNAME ?? saved.username;
  let token = process.env.GITLAB_TOKEN ?? saved.token;
  let prompted = false;

  if (!username) {
    process.stderr.write("GITLAB_USERNAME is not set.\n");
    username = await prompt("Enter your GitLab username: ");
    prompted = true;
  }

  if (!token) {
    process.stderr.write("GITLAB_TOKEN is not set.\n");
    process.stderr.write(`Create a personal access token with 'api' scope at:\n  ${GITLAB_TOKEN_URL}\n\n`);
    token = await prompt("Press Enter to open in your browser, or paste your token: ");
    if (token === "") {
      await openBrowser(GITLAB_TOKEN_URL);
      token = await prompt("Enter your GitLab API token: ");
    }
    prompted = true;
  }

  if (prompted) {
    const savedPath = await saveSettings({ username, token });
    if (savedPath) {
      process.stderr.write(`Credentials saved to ${savedPath}\n`);
    }
  }

  return { username, token };
}
