import { join } from "node:path";

export function getDataDir(): string {
  if (process.env.GITLAB_DATA_DIR) return process.env.GITLAB_DATA_DIR;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "gitlab-rebase");
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "gitlab-rebase");
  } else {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    return join(configHome, "gitlab-rebase");
  }
}
