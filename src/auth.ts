import { type } from "arktype";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { openBrowser } from "./manual/openBrowser";
import { textInputPrompt, withProgress } from "./manual/prompt";
import { q } from "./format";
import { getDataDir } from "./paths";

export const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=smart-rebase&scopes=api";

export interface GitLabAuth {
  token: string;
}

function getSettingsPath(): string {
  return join(getDataDir(), "credentials.json");
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

async function saveSettings(auth: GitLabAuth): Promise<string> {
  const settingsPath = getSettingsPath();
  try {
    await mkdir(getDataDir(), { recursive: true });
    await Bun.write(settingsPath, JSON.stringify(auth, null, 2));
  } catch (e) {
    throw new Error(
      `Failed to save credentials to ${settingsPath}: ${e instanceof Error ? e.message : e}\nSet ${q("GITLAB_DATA_DIR")} to change the location.`,
    );
  }
  return settingsPath;
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
    const tokens = text.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("#"));
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

export async function getAuth(stdin?: NodeJS.ReadableStream): Promise<GitLabAuth> {
  const saved = await withProgress("Checking settings...", () => loadSettings());

  let token = process.env.GITLAB_TOKEN;

  if (!token) {
    const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";
    const machine = new URL(gitlabUrl).hostname;
    token = await withProgress("Checking netrc...", () => loadNetrc(machine));
  }

  if (!token) {
    token = saved.token;
  }

  if (!token) {
    process.stderr.write(`Environment variable ${q("GITLAB_TOKEN")} is not set.\n`);
    process.stderr.write(`Create a personal access token with ${q("api")} scope at:\n  ${q(GITLAB_TOKEN_URL)}\n\n`);
    token = await textInputPrompt(`Press ${q("Enter")} to open in your browser, or paste your token: `, stdin);
    if (token === "") {
      await withProgress("Opening browser...", () => openBrowser(GITLAB_TOKEN_URL));
      token = await textInputPrompt("Enter your GitLab API token: ", stdin);
    }
    const savedToken = token;
    const savedPath = await withProgress("Saving settings...", () => saveSettings({ token: savedToken }));
    process.stderr.write(`GitLab token saved to ${savedPath}\n`);
  }

  return { token };
}
