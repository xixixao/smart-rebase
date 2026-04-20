import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const GITLAB_TOKEN_URL =
  "https://gitlab.com/-/user_settings/personal_access_tokens?name=gitlab-rebase&scopes=api";

const testConfigDir = mkdtempSync("/tmp/gitlab-rebase-test-config-");
const testCredsFile = join(testConfigDir, "gitlab-rebase", "credentials.json");

let mockMRs: object[] = [];
const mockCommits = new Map<number, object[]>();
let lastRequestedProject = "";

const mockGitLab = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const pathname = new URL(req.url).pathname;

    const projectMatch = pathname.match(/\/api\/v4\/projects\/([^/]+)/);
    if (projectMatch) lastRequestedProject = decodeURIComponent(projectMatch[1]);

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

afterAll(() => {
  mockGitLab.stop();
  rmSync(testConfigDir, { recursive: true, force: true });
});
beforeEach(() => {
  mockMRs = [];
  mockCommits.clear();
  lastRequestedProject = "";
  try { rmSync(testCredsFile); } catch {}
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
    XDG_CONFIG_HOME: testConfigDir,
    GITLAB_CACHE_DIR: mkdtempSync("/tmp/gitlab-rebase-test-"),
  };

  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) {
      delete spawnEnv[k];
    } else {
      spawnEnv[k] = v;
    }
  }

  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), ...args], {
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

async function makeGitRepo(remotes: Record<string, string> = {}): Promise<string> {
  const repoPath = mkdtempSync("/tmp/gitlab-rebase-test-");
  await Bun.$`git init`.cwd(repoPath).quiet();
  for (const [name, url] of Object.entries(remotes)) {
    await Bun.$`git remote add ${name} ${url}`.cwd(repoPath).quiet();
  }
  return repoPath;
}

// --- flag tests ---

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

test("--sha prints HEAD short sha", async () => {
  const GIT_DATE = "2020-01-01T00:00:00+00:00";
  const repoPath = await makeGitRepo();
  await Bun.$`git config user.email "test@example.com"`.cwd(repoPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(repoPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "Initial commit"`
    .cwd(repoPath)
    .env({ ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE })
    .quiet();
  const expectedSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const { stdout, exitCode } = await run(["--sha"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(expectedSha);
});

test("--sha is not printed without flag", async () => {
  const repoPath = await makeGitRepo();
  await Bun.$`git config user.email "test@example.com"`.cwd(repoPath).quiet();
  await Bun.$`git config user.name "Test"`.cwd(repoPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "init"`.cwd(repoPath).quiet();
  const sha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const { stdout } = await run([], { cwd: repoPath });
  expect(stdout).not.toContain(sha);
});

// --- auth tests ---

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

// --- MR fetching tests ---

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

// --- project detection tests ---

test("exits with error when project cannot be determined", async () => {
  const repoPath = await makeGitRepo();
  const { stderr, exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

test("detects project from origin remote", async () => {
  const repoPath = await makeGitRepo({
    origin: "git@gitlab.com:mygroup/myproject.git",
  });
  mockMRs = [{ iid: 5, title: "Origin MR", merge_commit_sha: null }];
  mockCommits.set(5, []);

  const { stdout, exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("mygroup/myproject");
  expect(stdout).toContain("!5 Origin MR");
});

test("detects project from the sole remote when it is not named origin", async () => {
  const repoPath = await makeGitRepo({
    upstream: "git@gitlab.com:org/upstream-project.git",
  });
  mockMRs = [{ iid: 6, title: "Upstream MR", merge_commit_sha: null }];
  mockCommits.set(6, []);

  const { stdout, exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("org/upstream-project");
  expect(stdout).toContain("!6 Upstream MR");
});

test("uses origin when both origin and another remote exist", async () => {
  const repoPath = await makeGitRepo({
    origin: "git@gitlab.com:maingroup/mainproject.git",
    fork: "git@gitlab.com:forkgroup/forkproject.git",
  });

  const { exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("maingroup/mainproject");
});

test("errors when multiple remotes exist and none is named origin", async () => {
  const repoPath = await makeGitRepo({
    foo: "git@gitlab.com:foo/project.git",
    bar: "git@gitlab.com:bar/project.git",
  });

  const { stderr, exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

// --- credentials storage tests ---

test("saves credentials to settings file when prompted and prints the path", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
    stdin: "myuser\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("Credentials saved to");
  expect(stderr).toContain(testConfigDir);
  const creds = await Bun.file(testCredsFile).json();
  expect(creds.username).toBe("myuser");
  expect(creds.token).toBe("mytoken");
});

test("loads credentials from settings file when env vars are not set", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ username: "saveduser", token: "savedtoken" }));

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_USERNAME is not set");
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
});

test("env vars take precedence over saved credentials", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ username: "saveduser", token: "savedtoken" }));

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: "envuser", GITLAB_TOKEN: "envtoken" },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_USERNAME is not set");
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
  expect(stderr).not.toContain("Credentials saved");
});

// --- cache tests ---

test("merges cached older MRs with fresh ones", async () => {
  const tmpDir = mkdtempSync("/tmp/gitlab-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old MR", merge_commit_sha: "abc" }];
  mockCommits.set(1, []);
  await run([], { env: { GITLAB_CACHE_DIR: tmpDir } });

  mockMRs = [{ iid: 2, title: "New MR", merge_commit_sha: "def" }];
  mockCommits.set(2, []);
  const { stdout, exitCode } = await run([], { env: { GITLAB_CACHE_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("!1 Old MR");
  expect(stdout).toContain("!2 New MR");
});

test("fresh data replaces cached version of same MR", async () => {
  const tmpDir = mkdtempSync("/tmp/gitlab-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old title", merge_commit_sha: "abc" }];
  mockCommits.set(1, []);
  await run([], { env: { GITLAB_CACHE_DIR: tmpDir } });

  mockMRs = [{ iid: 1, title: "Updated title", merge_commit_sha: "abc" }];
  mockCommits.set(1, []);
  const { stdout, exitCode } = await run([], { env: { GITLAB_CACHE_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Updated title");
  expect(stdout).not.toContain("Old title");
});
