import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { openBrowser } from "./manual/openBrowser";

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


function getSettingsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "gitlab-rebase", "credentials.json");
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "gitlab-rebase", "credentials.json");
  } else {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    return join(configHome, "gitlab-rebase", "credentials.json");
  }
}

async function loadSettings(): Promise<Partial<GitLabAuth>> {
  const file = Bun.file(getSettingsPath());
  if (!(await file.exists())) return {};
  try {
    const data = await file.json();
    return {
      username: typeof data.username === "string" ? data.username : undefined,
      token: typeof data.token === "string" ? data.token : undefined,
    };
  } catch {
    return {};
  }
}

async function saveSettings(auth: GitLabAuth): Promise<string | null> {
  const settingsPath = getSettingsPath();
  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await Bun.write(settingsPath, JSON.stringify(auth, null, 2));
    return settingsPath;
  } catch {
    return null;
  }
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
