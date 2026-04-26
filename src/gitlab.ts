import { type } from "arktype";

export function getGitlabUrl(): string {
  return process.env.GITLAB_URL ?? "https://gitlab.com";
}

const MergeRequest = type({
  iid: "number",
  title: "string",
  target_branch: "string",
  merged_at: "string | null",
  updated_at: "string",
});

const MRCommit = type({ id: "string", short_id: "string", title: "string" });

const MergeRequestArray = MergeRequest.array();
const MRCommitArray = MRCommit.array();

export type MergeRequest = typeof MergeRequest.infer;
export type MRCommit = typeof MRCommit.infer;

export interface MRWithCommits {
  mr: MergeRequest;
  commits: MRCommit[];
}

export async function fetchMergedMRsSince(opts: {
  baseUrl: string;
  projectId: string;
  token: string;
  since: string;
  perPage?: number;
}): Promise<MRWithCommits[]> {
  const { baseUrl, projectId, token, since } = opts;
  const perPage = opts.perPage ?? parseInt(process.env.GITLAB_PER_PAGE ?? "50");
  const sinceDate = new Date(since);
  const encodedProject = encodeURIComponent(projectId);
  const headers = { "PRIVATE-TOKEN": token };

  const allMrs: MergeRequest[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=${perPage}&page=${page}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`GitLab API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const mrs = MergeRequestArray(data);
    if (mrs instanceof type.errors) throw new Error(`Invalid MR list: ${mrs.summary}`);

    allMrs.push(...mrs);

    if (mrs.length === 0 || mrs.length < perPage || new Date(mrs.at(-1)!.updated_at) < sinceDate) break;
    page++;
  }

  return Promise.all(
    allMrs.map(async (mr) => {
      const commitsRes = await fetch(`${baseUrl}/api/v4/projects/${encodedProject}/merge_requests/${mr.iid}/commits`, {
        headers,
      });
      if (!commitsRes.ok) {
        throw new Error(`GitLab API error ${commitsRes.status} for MR !${mr.iid}: ${await commitsRes.text()}`);
      }
      const commitsData = await commitsRes.json();
      const commits = MRCommitArray(commitsData);
      if (commits instanceof type.errors) throw new Error(`Invalid commits for MR !${mr.iid}: ${commits.summary}`);
      return { mr, commits };
    }),
  );
}
