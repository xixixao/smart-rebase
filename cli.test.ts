import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { main } from "./index";
import { GITLAB_TOKEN_URL } from "./auth";

const testConfigDir = mkdtempSync("/tmp/gitlab-rebase-test-config-");
const testCredsFile = join(testConfigDir, "gitlab-rebase", "credentials.json");

let mockMRs: object[] = [];
const mockCommits = new Map<number, object[]>();
let lastRequestedProject = "";
let mockMRsError = false;
let mockMRsStatusCode = 200;
let mockCommitsErrorIid: number | null = null;

const mockGitLab = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const pathname = new URL(req.url).pathname;

    const projectMatch = pathname.match(/\/api\/v4\/projects\/([^/]+)/);
    if (projectMatch) lastRequestedProject = decodeURIComponent(projectMatch[1]);

    const commitsMatch = pathname.match(/\/merge_requests\/(\d+)\/commits$/);
    if (commitsMatch) {
      const iid = parseInt(commitsMatch[1]);
      if (mockCommitsErrorIid !== null && iid === mockCommitsErrorIid) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json(mockCommits.get(iid) ?? []);
    }
    if (pathname.match(/\/merge_requests$/)) {
      if (mockMRsStatusCode !== 200) return new Response("Server Error", { status: mockMRsStatusCode });
      if (mockMRsError) return Response.json([{ iid: "not-a-number", title: "Bad", merge_commit_sha: null }]);
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
  mockMRsError = false;
  mockMRsStatusCode = 200;
  mockCommitsErrorIid = null;
  try { rmSync(testCredsFile); } catch {}
});

const GITLAB_URL = `http://localhost:${mockGitLab.port}`;

async function run(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    cwd?: string;
    omitStdin?: boolean;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const testEnv: Record<string, string | undefined> = {
    GITLAB_USERNAME: "testuser",
    GITLAB_TOKEN: "testtoken",
    GITLAB_URL,
    GITLAB_PROJECT: "testgroup/testrepo",
    XDG_CONFIG_HOME: testConfigDir,
    GITLAB_CACHE_DIR: mkdtempSync("/tmp/gitlab-rebase-test-"),
    ...opts.env,
  };

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(testEnv)) {
    savedEnv[key] = process.env[key];
    if (testEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = testEnv[key];
    }
  }

  const stdinLines = makeStdinIterator(opts.stdin ?? "");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const origLog = console.log;
  const origStderrWrite = process.stderr.write;

  console.log = (...args: unknown[]) => {
    stdoutBuffer += args.map(String).join(" ") + "\n";
  };
  (process.stderr as any).write = (chunk: string | Uint8Array) => {
    stderrBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  let exitCode = 0;
  try {
    await main(args, { cwd: opts.cwd ?? import.meta.dir, ...(opts.omitStdin ? {} : { stdinLines }) });
  } catch (e: unknown) {
    exitCode = 1;
    stderrBuffer += (e instanceof Error ? e.message : String(e)) + "\n";
  } finally {
    console.log = origLog;
    (process.stderr as any).write = origStderrWrite;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }

  return { stdout: stdoutBuffer, stderr: stderrBuffer, exitCode };
}

function makeStdinIterator(input: string): AsyncIterator<string> {
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let i = 0;
  return {
    async next() {
      if (i < lines.length) return { value: lines[i++], done: false as const };
      return { value: "" as string, done: true as const };
    },
  };
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

// --- error handling tests ---

test("handles invalid JSON in credentials file by prompting again", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  writeFileSync(testCredsFile, "not valid json{{{");

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
    stdin: "myuser\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_USERNAME is not set");
});

test("exits with error when MRs API returns non-OK HTTP status", async () => {
  mockMRsStatusCode = 500;
  const { stderr, exitCode } = await run([]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("500");
});

test("exits with error when GitLab returns invalid MR format", async () => {
  mockMRsError = true;
  const { stderr, exitCode } = await run([]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Invalid MR list");
});

test("exits with error when commits API returns an error", async () => {
  mockMRs = [{ iid: 99, title: "Some MR", merge_commit_sha: null }];
  mockCommitsErrorIid = 99;

  const { stderr, exitCode } = await run([]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("500");
});

test("exits with error when cwd is not a git repository", async () => {
  const nonGitDir = mkdtempSync("/tmp/gitlab-rebase-not-git-");
  const { stderr, exitCode } = await run([], {
    cwd: nonGitDir,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

test("exits with error when remote exists but has no URL configured", async () => {
  const repoPath = mkdtempSync("/tmp/gitlab-rebase-broken-remote-");
  await Bun.$`git init`.cwd(repoPath).quiet();
  await Bun.$`git remote add origin git@gitlab.com:foo/bar`.cwd(repoPath).quiet();
  await Bun.$`git config --unset remote.origin.url`.cwd(repoPath).quiet();

  const { stderr, exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

test("uses default cache directory when GITLAB_CACHE_DIR is not set", async () => {
  const homeDir = mkdtempSync("/tmp/gitlab-rebase-home-");
  const { exitCode } = await run([], {
    env: { GITLAB_CACHE_DIR: undefined, HOME: homeDir },
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(homeDir, ".cache", "gitlab-rebase"))).toBe(true);
});

test("uses readline for stdin when no stdinLines are provided", async () => {
  // GITLAB_USERNAME and GITLAB_TOKEN are set by default so no prompting happens;
  // getDefaultStdinLines() is called but never read from
  const { exitCode } = await run([], { omitStdin: true });
  expect(exitCode).toBe(0);
});

test("proceeds gracefully when credentials cannot be saved", async () => {
  // Place a file where the credentials directory should be so mkdir fails
  const blockingBase = mkdtempSync("/tmp/gitlab-rebase-block-");
  writeFileSync(join(blockingBase, "gitlab-rebase"), "blocker");

  const { stderr, exitCode } = await run([], {
    env: {
      GITLAB_USERNAME: undefined,
      GITLAB_TOKEN: undefined,
      XDG_CONFIG_HOME: blockingBase,
    },
    stdin: "myuser\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("Credentials saved");
});

test("handles corrupted cache file gracefully", async () => {
  const cacheDir = mkdtempSync("/tmp/gitlab-rebase-cache-corrupt-");
  const key = `${GITLAB_URL}:testgroup/testrepo`.replace(/[^a-zA-Z0-9.-]/g, "_");
  writeFileSync(join(cacheDir, `${key}.json`), "corrupted{{{{");

  const { exitCode } = await run([], { env: { GITLAB_CACHE_DIR: cacheDir } });
  expect(exitCode).toBe(0);
});
