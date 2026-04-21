import { type } from "arktype";

const MergeRequest = type({
  iid: "number",
  title: "string",
  merge_commit_sha: "string | null",
});

const MRCommit = type({
  id: "string",
  short_id: "string",
  title: "string",
});

const MergeRequestArray = MergeRequest.array();
const MRCommitArray = MRCommit.array();

export type MergeRequest = typeof MergeRequest.infer;
export type MRCommit = typeof MRCommit.infer;

export interface MRWithCommits {
  mr: MergeRequest;
  commits: MRCommit[];
}

export async function fetchRecentMergedMRs(opts: {
  baseUrl: string;
  projectId: string;
  token: string;
  perPage?: number;
  mergedAfter?: string;
}): Promise<MRWithCommits[]> {
  const { baseUrl, projectId, token, perPage = 100, mergedAfter } = opts;
  const encodedProject = encodeURIComponent(projectId);
  const headers = { "PRIVATE-TOKEN": token };

  const params = new URLSearchParams({
    state: "merged",
    order_by: "updated_at",
    sort: "desc",
    per_page: String(perPage),
  });
  if (mergedAfter) params.set("merged_after", mergedAfter);

  const mrsRes = await fetch(
    `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests?${params}`,
    { headers }
  );
  if (!mrsRes.ok) {
    throw new Error(`GitLab API error ${mrsRes.status}: ${await mrsRes.text()}`);
  }
  const mrsData = await mrsRes.json();
  const mrs = MergeRequestArray(mrsData);
  if (mrs instanceof type.errors) throw new Error(`Invalid MR list: ${mrs.summary}`);

  return Promise.all(
    mrs.map(async (mr) => {
      const commitsRes = await fetch(
        `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests/${mr.iid}/commits`,
        { headers }
      );
      if (!commitsRes.ok) {
        throw new Error(
          `GitLab API error ${commitsRes.status} for MR !${mr.iid}: ${await commitsRes.text()}`
        );
      }
      const commitsData = await commitsRes.json();
      const commits = MRCommitArray(commitsData);
      if (commits instanceof type.errors)
        throw new Error(`Invalid commits for MR !${mr.iid}: ${commits.summary}`);
      return { mr, commits };
    })
  );
}
