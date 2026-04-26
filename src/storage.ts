import { type } from "arktype";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MRWithCommits } from "./gitlab";
import { getGitlabUrl } from "./gitlab";
import { getDataDir } from "./paths";
import { q } from "./format";

const CACHE_VERSION = 5;

const CachedCommit = type({ id: "string", short_id: "string", title: "string" });

const CachedMR = type({
  iid: "number",
  title: "string",
  target_branch: "string",
  merged_at: "string | null",
  updated_at: "string",
});

const CachedEntry = type({ mr: CachedMR, commits: CachedCommit.array() });

const CacheFile = type({ version: "number", mrs: CachedEntry.array(), mergeBaseCommitAt: "string" });

/** Cached MR list plus the merge-base commit date used when the cache was last written. */
export type MrsProjectCache = { mrs: MRWithCommits[]; mergeBaseCommitAt: string };

function cachePath(baseUrl: string, projectId: string): string {
  const key = `${baseUrl}:${projectId}`.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(getDataDir(), `${key}.json`);
}

export async function readCache(projectId: string): Promise<MrsProjectCache | null> {
  const baseUrl = getGitlabUrl();
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

  return { mrs: data.mrs, mergeBaseCommitAt: data.mergeBaseCommitAt! };
}

export async function writeCache(projectId: string, mrs: MRWithCommits[], mergeBaseCommitAt: string): Promise<void> {
  const baseUrl = getGitlabUrl();
  const path = cachePath(baseUrl, projectId);
  try {
    mkdirSync(getDataDir(), { recursive: true });
    await Bun.write(path, JSON.stringify({ version: CACHE_VERSION, mrs, mergeBaseCommitAt }));
  } catch (e) {
    throw new Error(
      `Failed to write cache to ${path}: ${e instanceof Error ? e.message : e}\nSet ${q("GITLAB_DATA_DIR")} to change the location.`,
    );
  }
}
