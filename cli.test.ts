import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

// Mutable state driven by individual tests; reset before each test.
let mockMRs: object[] = [];
const mockCommits = new Map<number, object[]>();

const mockGitLab = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const pathname = new URL(req.url).pathname;
    const commitsMatch = pathname.match(/\/merge_requests\/(\d+)\/commits$/);
    if (commitsMatch) {
      return Response.json(mockCommits.get(parseInt(commitsMatch[1])) ?? []);
    }
    if (pathname.match(/\/merge_requests$/)) {
      return Response.json(mockMRs);
    }
    return new Response("Not Found", { status: 404 });
  },
});

afterAll(() => mockGitLab.stop());
beforeEach(() => {
  mockMRs = [];
  mockCommits.clear();
});

const GITLAB_URL = `http://localhost:${mockGitLab.port}`;

async function run(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    cwd?: string;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const processEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) processEnv[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...processEnv,
    GITLAB_USERNAME: "testuser",
    GITLAB_TOKEN: "testtoken",
    GITLAB_URL,
    GITLAB_PROJECT: "testgroup/testrepo",
  };

  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) {
      delete spawnEnv[k];
    } else {
      spawnEnv[k] = v;
    }
  }

  const proc = Bun.spawn(["bun", "run", "index.ts", ...args], {
    cwd: opts.cwd ?? import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
  });

  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.flush();
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function makeBrowserScript(): Promise<{ browserScript: string; browserLog: string }> {
  const tmpDir = mkdtempSync("/tmp/gitlab-rebase-test-");
  const browserScript = join(tmpDir, "browser.sh");
  const browserLog = join(tmpDir, "browser-url.txt");
  await Bun.write(browserScript, `#!/bin/sh\necho "$1" > "${browserLog}"\n`);
  await Bun.$`chmod +x ${browserScript}`.quiet();
  return { browserScript, browserLog };
}

test("verbose defaults to false", async () => {
  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("Verbose mode enabled");
});

test("--verbose flag is recognised", async () => {
  const { stdout, exitCode } = await run(["--verbose"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Verbose mode enabled");
});

test("-v alias works", async () => {
  const { stdout, exitCode } = await run(["-v"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Verbose mode enabled");
});

test("unknown flag exits with non-zero code", async () => {
  const { exitCode } = await run(["--unknown"]);
  expect(exitCode).not.toBe(0);
});

test("runs without auth prompts when env vars are set", async () => {
  const { stderr, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_USERNAME");
  expect(stderr).not.toContain("GITLAB_TOKEN");
});

test("prompts for username when GITLAB_USERNAME is not set", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined },
    stdin: "myuser\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_USERNAME");
});

test("prompts for token when GITLAB_TOKEN is not set", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN");
  expect(stderr).toContain("gitlab.com");
});

test("token prompt shows GitLab URL with api scope", async () => {
  const { stderr } = await run([], {
    env: { GITLAB_TOKEN: undefined },
    stdin: "mytoken\n",
  });
  expect(stderr).toContain(GITLAB_TOKEN_URL);
});

test("opens browser when user presses Enter on token prompt", async () => {
  const { browserScript, browserLog } = await makeBrowserScript();
  const { exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: browserScript },
    stdin: "\nmyfinaltoken\n",
  });
  expect(exitCode).toBe(0);
  const openedUrl = await Bun.file(browserLog).text();
  expect(openedUrl.trim()).toBe(GITLAB_TOKEN_URL);
});

test("does not open browser when token is pasted directly", async () => {
  const { browserScript, browserLog } = await makeBrowserScript();
  const { exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: browserScript },
    stdin: "pastedtoken\n",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(browserLog)).toBe(false);
});

test("prompts for both credentials when neither env var is set", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
    stdin: "myuser\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_USERNAME");
  expect(stderr).toContain("GITLAB_TOKEN");
});

test("accepts credentials with surrounding whitespace", async () => {
  const { exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
    stdin: "  myuser  \n  mytoken  \n",
  });
  expect(exitCode).toBe(0);
});

test("prints merged MRs with their commits", async () => {
  mockMRs = [
    { iid: 1, title: "Add feature", merge_commit_sha: "abc123" },
    { iid: 2, title: "Fix bug", merge_commit_sha: "def456" },
  ];
  mockCommits.set(1, [{ id: "sha1full", short_id: "sha1ful", title: "Implement feature" }]);
  mockCommits.set(2, [
    { id: "sha2full", short_id: "sha2ful", title: "Fix the bug" },
    { id: "sha3full", short_id: "sha3ful", title: "Add test for fix" },
  ]);

  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("!1 Add feature");
  expect(stdout).toContain("sha1ful Implement feature");
  expect(stdout).toContain("!2 Fix bug");
  expect(stdout).toContain("sha2ful Fix the bug");
  expect(stdout).toContain("sha3ful Add test for fix");
});

test("outputs nothing when there are no merged MRs", async () => {
  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("");
});

test("fetches commits for all MRs", async () => {
  mockMRs = [
    { iid: 10, title: "MR ten", merge_commit_sha: null },
    { iid: 20, title: "MR twenty", merge_commit_sha: null },
    { iid: 30, title: "MR thirty", merge_commit_sha: null },
  ];
  mockCommits.set(10, [{ id: "c10full", short_id: "c10", title: "Commit 10" }]);
  mockCommits.set(20, [{ id: "c20full", short_id: "c20", title: "Commit 20" }]);
  mockCommits.set(30, [{ id: "c30full", short_id: "c30", title: "Commit 30" }]);

  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Commit 10");
  expect(stdout).toContain("Commit 20");
  expect(stdout).toContain("Commit 30");
});

test("exits with error when project cannot be determined", async () => {
  const { stderr, exitCode } = await run([], { env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});
