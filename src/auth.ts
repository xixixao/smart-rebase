import { type } from "arktype";
import { createInterface, type Interface } from "node:readline";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { openBrowser } from "./manual/openBrowser";

export const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

export interface GitLabAuth {
  token: string;
}

let _defaultStdinLines: AsyncIterator<string> | undefined;
let _defaultStdinRl: Interface | undefined;

function closeDefaultStdinLines(): void {
  _defaultStdinRl?.close();
  _defaultStdinRl = undefined;
  _defaultStdinLines = undefined;
}

export function getDefaultStdinLines(): AsyncIterator<string> {
  if (!_defaultStdinLines) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });
    _defaultStdinRl = rl;
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

const SettingsSchema = type({ "token?": "string" });

async function loadSettings(): Promise<Partial<GitLabAuth>> {
  const file = Bun.file(getSettingsPath());
  if (!(await file.exists())) return {};
  try {
    const data = SettingsSchema(await file.json());
    if (data instanceof type.errors) return {};
    return { token: data.token };
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

function getNetrcPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".netrc");
}

async function loadNetrc(machine: string): Promise<string | undefined> {
  const file = Bun.file(getNetrcPath());
  if (!(await file.exists())) return undefined;
  try {
    const text = await file.text();
    // Tokenize the .netrc file (comments start with #)
    const tokens = text
      .split(/\s+/)
      .filter((t) => t.length > 0 && !t.startsWith("#"));
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i] === "machine" && tokens[i + 1] === machine) {
        i += 2;
        while (i < tokens.length && tokens[i] !== "machine" && tokens[i] !== "default") {
          if (tokens[i] === "password") return tokens[i + 1];
          i += 2;
        }
        return undefined;
      }
      i++;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export async function getAuth(stdinLines?: AsyncIterator<string>): Promise<GitLabAuth> {
  try {
    async function prompt(question: string): Promise<string> {
      process.stderr.write(question);
      const lines = stdinLines ?? getDefaultStdinLines();
      const result = await lines.next();
      return result.done ? "" : result.value.trim();
    }

    const saved = await loadSettings();

    let token = process.env.GITLAB_TOKEN;

    if (!token) {
      const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";
      const machine = new URL(gitlabUrl).hostname;
      token = await loadNetrc(machine);
    }

    if (!token) {
      token = saved.token;
    }

    if (!token) {
      process.stderr.write("GITLAB_TOKEN is not set.\n");
      process.stderr.write(
        `Create a personal access token with 'api' scope at:\n  ${GITLAB_TOKEN_URL}\n\n`,
      );
      token = await prompt("Press Enter to open in your browser, or paste your token: ");
      if (token === "") {
        await openBrowser(GITLAB_TOKEN_URL);
        token = await prompt("Enter your GitLab API token: ");
      }
      const savedPath = await saveSettings({ token });
      if (savedPath) {
        process.stderr.write(`Credentials saved to ${savedPath}\n`);
      }
    }

    return { token };
  } finally {
    if (stdinLines === undefined) {
      closeDefaultStdinLines();
    }
  }
}
