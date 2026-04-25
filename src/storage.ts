import { type } from "arktype";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MRWithCommits } from "./gitlab";
import { getDataDir } from "./paths";
import { q } from "./format";

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

function cachePath(baseUrl: string, projectId: string): string {
  const key = `${baseUrl}:${projectId}`.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(getDataDir(), `${key}.json`);
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
  const path = cachePath(baseUrl, projectId);
  try {
    mkdirSync(getDataDir(), { recursive: true });
    await Bun.write(path, JSON.stringify({ version: CACHE_VERSION, mrs }));
  } catch (e) {
    throw new Error(
      `Failed to write cache to ${path}: ${e instanceof Error ? e.message : e}\nSet ${q("GITLAB_DATA_DIR")} to change the location.`
    );
  }
}
