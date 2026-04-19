export interface MergeRequest {
  iid: number;
  title: string;
  merge_commit_sha: string | null;
}

export interface MRCommit {
  id: string;
  short_id: string;
  title: string;
}

export interface MRWithCommits {
  mr: MergeRequest;
  commits: MRCommit[];
}

export async function fetchRecentMergedMRs(opts: {
  baseUrl: string;
  projectId: string;
  token: string;
  perPage?: number;
}): Promise<MRWithCommits[]> {
  const { baseUrl, projectId, token, perPage = 20 } = opts;
  const encodedProject = encodeURIComponent(projectId);
  const headers = { "PRIVATE-TOKEN": token };

  const mrsRes = await fetch(
    `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=${perPage}`,
    { headers }
  );
  if (!mrsRes.ok) {
    throw new Error(`GitLab API error ${mrsRes.status}: ${await mrsRes.text()}`);
  }
  const mrs: MergeRequest[] = await mrsRes.json();

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
      const commits: MRCommit[] = await commitsRes.json();
      return { mr, commits };
    })
  );
}
