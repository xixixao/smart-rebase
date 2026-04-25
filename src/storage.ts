import { type } from "arktype";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MRWithCommits } from "./gitlab";

const CACHE_VERSION = 4;

const CachedCommit = type({
  id: "string",
  short_id: "string",
  title: "string",
});

const CachedMR = type({
  iid: "number",
  title: "string",
  target_branch: "string",
  merged_at: "string | null",
  updated_at: "string",
});

const CachedEntry = type({
  mr: CachedMR,
  commits: CachedCommit.array(),
});

const CacheFile = type({
  version: "number",
  mrs: CachedEntry.array(),
});

function cacheDir(): string {
  if (process.env.GITLAB_CACHE_DIR) return process.env.GITLAB_CACHE_DIR;
  const home = process.env.HOME ?? "/tmp";
  return join(home, ".cache", "gitlab-rebase");
}

function cachePath(baseUrl: string, projectId: string): string {
  const key = `${baseUrl}:${projectId}`.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(cacheDir(), `${key}.json`);
}

export async function readCache(
  baseUrl: string,
  projectId: string
): Promise<MRWithCommits[] | null> {
  const file = Bun.file(cachePath(baseUrl, projectId));
  if (!(await file.exists())) return null;

  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return null;
  }

  const data = CacheFile(raw);
  if (data instanceof type.errors) return null;
  if (data.version !== CACHE_VERSION) return null;

  return data.mrs;
}

export async function writeCache(
  baseUrl: string,
  projectId: string,
  mrs: MRWithCommits[]
): Promise<void> {
  mkdirSync(cacheDir(), { recursive: true });
  await Bun.write(
    cachePath(baseUrl, projectId),
    JSON.stringify({ version: CACHE_VERSION, mrs })
  );
}
