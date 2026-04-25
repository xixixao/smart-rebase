import { test, expect, afterAll, beforeAll, beforeEach, jest } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { main } from "./index";
import { GITLAB_TOKEN_URL } from "./auth";

const testConfigDir = mkdtempSync("/tmp/gitlab-rebase-test-config-");
const testCredsFile = join(testConfigDir, "gitlab-rebase", "credentials.json");

// Dates relative to the fixed initial commit date ("2020-01-01") used in makeGitRepo.
const RECENT = "2021-01-01T00:00:00+00:00"; // after base → MR passes merged_at filter
const OLD = "2019-01-01T00:00:00+00:00";    // before base → MR fails merged_at filter

let mockMRs: object[] = [];
const mockCommits = new Map<number, object[]>();
let lastRequestedProject = "";
let mrPagesFetched = 0;
let mockCommitsRequestCount = 0;
let mockMRsError = false;
let mockMRsStatusCode = 200;
let mockCommitsErrorIid: number | null = null;

const mockGitLab = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    const projectMatch = pathname.match(/\/api\/v4\/projects\/([^/]+)/);
    if (projectMatch) lastRequestedProject = decodeURIComponent(projectMatch[1]!);

    const commitsMatch = pathname.match(/\/merge_requests\/(\d+)\/commits$/);
    if (commitsMatch) {
      mockCommitsRequestCount++;
      const iid = parseInt(commitsMatch[1]!);
      if (mockCommitsErrorIid !== null && iid === mockCommitsErrorIid) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json(mockCommits.get(iid) ?? []);
    }
    if (pathname.match(/\/merge_requests$/)) {
      mrPagesFetched++;
      if (mockMRsStatusCode !== 200) return new Response("Server Error", { status: mockMRsStatusCode });
      if (mockMRsError) return Response.json([{ iid: "not-a-number", title: "Bad", target_branch: "main", merged_at: null, updated_at: OLD }]);
      const page = parseInt(url.searchParams.get("page") ?? "1");
      const perPage = parseInt(url.searchParams.get("per_page") ?? "50");
      return Response.json(mockMRs.slice((page - 1) * perPage, page * perPage));
    }
    return new Response("Not Found", { status: 404 });
  },
});

// Shared fixture: a repo where HEAD is on a feature branch and main has
// two commits (sha1, sha2) that landed after the feature branch diverged.
let defaultTestCwd = "";
let defaultMainShas: [string, string] = ["", ""];
let defaultFeatureSha = "";

beforeAll(async () => {
  const { repoPath, mainCommitShas, featureCommitSha } = await makeRepoWithDivergedBranch();
  defaultTestCwd = repoPath;
  defaultMainShas = mainCommitShas;
  defaultFeatureSha = featureCommitSha;
});

afterAll(() => {
  mockGitLab.stop();
  rmSync(testConfigDir, { recursive: true, force: true });
});
beforeEach(async () => {
  mockMRs = [];
  mockCommits.clear();
  lastRequestedProject = "";
  mrPagesFetched = 0;
  mockCommitsRequestCount = 0;
  mockMRsError = false;
  mockMRsStatusCode = 200;
  mockCommitsErrorIid = null;
  try { rmSync(testCredsFile); } catch {}
  // Reset shared repo: git rebase in main() moves the feature branch, so restore it.
  if (defaultTestCwd && defaultFeatureSha) {
    await Bun.$`git checkout feature`.cwd(defaultTestCwd).quiet().nothrow();
    await Bun.$`git reset --hard ${defaultFeatureSha}`.cwd(defaultTestCwd).quiet().nothrow();
  }
});

const GITLAB_URL = `http://localhost:${mockGitLab.port}`;

// KEY_ENTER / KEY_DOWN are raw terminal key codes used to drive the ink SelectInput prompt.
const KEY_ENTER = "\r";
const KEY_DOWN = "\x1B[B";

function parseKeySequences(keys: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < keys.length) {
    if (keys.slice(i, i + 3) === "\x1B[A" || keys.slice(i, i + 3) === "\x1B[B" ||
        keys.slice(i, i + 3) === "\x1B[C" || keys.slice(i, i + 3) === "\x1B[D") {
      result.push(keys.slice(i, i + 3));
      i += 3;
    } else {
      result.push(keys[i]!);
      i++;
    }
  }
  return result;
}

// Modelled after ink-testing-library's Stdin (https://github.com/vadimdemedes/ink/blob/master/src/testing-library.ts):
// a plain EventEmitter that stores the latest chunk in `.data`, emits
// `readable`/`data` on write, and returns the chunk from `.read()`.
// Ink 7's input handler expects exactly this shape.
//
// We queue the key sequences and dispatch them from setRawMode(true), which
// ink calls right after it wires up its readable listener — this is our signal
// that ink is ready for input. Each key is written on its own tick so React
// can flush the state update from the previous key before the next arrives.
class TestStdin extends EventEmitter {
  isTTY = true;
  data: Buffer | string | null = null;
  private remaining: string[] = [];
  enqueue(sequences: string[]): void {
    this.remaining = [...sequences];
  }
  setRawMode = (mode: boolean): void => {
    if (!mode || this.remaining.length === 0) return;
    // Send keys one at a time; pause after Enter so the next prompt's
    // setRawMode(true) picks up from where this one left off.
    const send = (): void => {
      if (this.remaining.length === 0) return;
      const seq = this.remaining.shift()!;
      this.write(Buffer.from(seq));
      if (seq !== "\r") setImmediate(send);
    };
    setImmediate(send);
  };
  write = (data: Buffer | string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding = (): void => {};
  resume = (): void => {};
  pause = (): void => {};
  ref = (): void => {};
  unref = (): void => {};
  read = (): Buffer | string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

function makeInkStdinStream(keys: string): TestStdin {
  const stdin = new TestStdin();
  stdin.enqueue(parseKeySequences(keys));
  return stdin;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;?]*[mGKHFJABCDEFGST]/g, "").replace(/\x1B[>=]/g, "");
}

async function run(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    inkStdin?: string;
    cwd?: string;
    omitStdin?: boolean;
    platform?: NodeJS.Platform;
    stdoutIsTTY?: boolean;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const spyOnGetter = jest.spyOn as (obj: NodeJS.Process, key: "platform", accessor: "get") => { mockReturnValue: (v: NodeJS.Platform) => void; mockRestore: () => void };
  const platformSpy = spyOnGetter(process, "platform", "get");
  platformSpy.mockReturnValue(opts.platform ?? "linux");

  const testEnv: Record<string, string | undefined> = {
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
  const inkStream = makeInkStdinStream(opts.inkStdin ?? "");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const origLog = console.log;
  const origError = console.error;
  const origStderrWrite = process.stderr.write;
  const origStderrIsTTY = process.stderr.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  console.log = (...args: unknown[]) => {
    stdoutBuffer += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    stderrBuffer += args.map(String).join(" ") + "\n";
  };
  (process.stderr as NodeJS.WriteStream & { write: unknown }).write = (chunk: string | Uint8Array) => {
    stderrBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  (process.stderr as NodeJS.WriteStream & { isTTY: unknown }).isTTY = false;
  (process.stdout as NodeJS.WriteStream & { isTTY: unknown }).isTTY = opts.stdoutIsTTY ?? false;

  let exitCode = 0;
  try {
    await main(args, {
      cwd: opts.cwd ?? defaultTestCwd,
      ...(opts.omitStdin ? {} : { stdinLines }),
      stdin: inkStream as unknown as NodeJS.ReadableStream,
    });
  } catch (e: unknown) {
    exitCode = 1;
    stderrBuffer += (e instanceof Error ? e.message : String(e)) + "\n";
  } finally {
    platformSpy.mockRestore();
    console.log = origLog;
    console.error = origError;
    (process.stderr as NodeJS.WriteStream & { write: unknown }).write = origStderrWrite;
    (process.stderr as NodeJS.WriteStream & { isTTY: unknown }).isTTY = origStderrIsTTY;
    (process.stdout as NodeJS.WriteStream & { isTTY: unknown }).isTTY = origStdoutIsTTY;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }

  return { stdout: stripAnsi(stdoutBuffer), stderr: stripAnsi(stderrBuffer), exitCode };
}

function makeStdinIterator(input: string): AsyncIterator<string> {
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let i = 0;
  return {
    async next() {
      if (i < lines.length) return { value: lines[i++]!, done: false as const };
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
  await Bun.$`git init -b main`.cwd(repoPath).quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(repoPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(repoPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(repoPath).quiet();
  // Fixed date so the base commit date is always "2020-01-01T00:00:00+00:00",
  // making mock MR dates predictable (RECENT = 2021, OLD = 2019).
  const D = "2020-01-01T00:00:00+00:00";
  await Bun.$`git commit --allow-empty -m "Initial commit"`.cwd(repoPath)
    .env({ ...process.env, GIT_AUTHOR_DATE: D, GIT_COMMITTER_DATE: D })
    .quiet();
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

test("uses colors instead of backticks when stdout is a TTY", async () => {
  const { stdout, exitCode } = await run([], { stdoutIsTTY: true });
  expect(exitCode).toBe(0);
  // ANSI codes are stripped here; names appear without backtick delimiters
  expect(stdout.trim()).toBe(
    "Rebasing onto branch main.\nRebasing feature onto main. 0 commits have already been merged to main. Will rebase 1 commit."
  );
});

test("--verbose flag is recognised", async () => {
  const { stdout, exitCode } = await run(["--verbose"]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    "Rebasing onto branch `main`.\nRebasing `feature` onto `main`. 0 commits have already been merged to `main`. Will rebase 1 commit.\n"
  );
});

test("-v alias works", async () => {
  const { stdout, exitCode } = await run(["-v"]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    "Rebasing onto branch `main`.\nRebasing `feature` onto `main`. 0 commits have already been merged to `main`. Will rebase 1 commit.\n"
  );
});

test("unknown flag exits with non-zero code", async () => {
  const { exitCode } = await run(["--unknown"]);
  expect(exitCode).not.toBe(0);
});

test("--sha prints HEAD short sha", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  const expectedSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const { stdout, exitCode } = await run(["--sha"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(expectedSha);
});

test("--sha is not printed without flag", async () => {
  const repoPath = await makeGitRepo();
  const sha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const { stdout } = await run([], { cwd: repoPath });
  expect(stdout).not.toContain(sha);
});

// --- auth tests ---

test("runs without auth prompts when env vars are set", async () => {
  const { stderr, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN");
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

test("continues normally when browser command fails to launch", async () => {
  const { exitCode, stderr } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: "false" },
    stdin: "\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("Enter your GitLab API token");
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

test("accepts token with surrounding whitespace", async () => {
  const { exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined },
    stdin: "  mytoken  \n",
  });
  expect(exitCode).toBe(0);
});

// --- MR fetching tests ---

test("prints merged MRs with their commits", async () => {
  const { repoPath, mergedShas } = await makeRepoWithMergedAndNewFeature(2);
  mockMRs = [
    { iid: 1, title: "Add feature", target_branch: "main", merged_at: RECENT, updated_at: RECENT },
    { iid: 2, title: "Fix bug", target_branch: "main", merged_at: RECENT, updated_at: RECENT },
  ];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "Implement feature" }]);
  mockCommits.set(2, [
    { id: mergedShas[1]!, short_id: mergedShas[1]!.slice(0, 8), title: "Fix the bug" },
    { id: mergedShas[1]!, short_id: mergedShas[1]!.slice(0, 8), title: "Add test for fix" },
  ]);

  const { stdout, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("!1 Add feature");
  expect(stdout).toContain(`${mergedShas[0]!.slice(0, 8)} Implement feature`);
  expect(stdout).toContain("!2 Fix bug");
  expect(stdout).toContain(`${mergedShas[1]!.slice(0, 8)} Fix the bug`);
  expect(stdout).toContain(`${mergedShas[1]!.slice(0, 8)} Add test for fix`);
});

test("outputs only the rebase summary when there are no merged MRs", async () => {
  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(
    "Rebasing onto branch `main`.\n" +
      "Rebasing `feature` onto `main`. 0 commits have already been merged to `main`. Will rebase 1 commit."
  );
});

test("fetches commits for all MRs", async () => {
  // MRs target a different branch so they don't affect rebase, but commits
  // are still fetched for every MR returned by the API (for caching purposes).
  mockMRs = [
    { iid: 10, title: "MR ten", target_branch: "other", merged_at: RECENT, updated_at: RECENT },
    { iid: 20, title: "MR twenty", target_branch: "other", merged_at: RECENT, updated_at: RECENT },
    { iid: 30, title: "MR thirty", target_branch: "other", merged_at: RECENT, updated_at: RECENT },
  ];

  const { exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(mockCommitsRequestCount).toBe(3);
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
  const { repoPath } = await makeRepoWithDivergedBranch();
  await Bun.$`git remote add origin git@gitlab.com:mygroup/myproject.git`.cwd(repoPath).quiet();

  const { exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("mygroup/myproject");
});

test("detects project from the sole remote when it is not named origin", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  await Bun.$`git remote add upstream git@gitlab.com:org/upstream-project.git`.cwd(repoPath).quiet();

  const { exitCode } = await run([], {
    cwd: repoPath,
    env: { GITLAB_PROJECT: undefined },
  });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("org/upstream-project");
});

test("uses origin when both origin and another remote exist", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  await Bun.$`git remote add origin git@gitlab.com:maingroup/mainproject.git`.cwd(repoPath).quiet();
  await Bun.$`git remote add fork git@gitlab.com:forkgroup/forkproject.git`.cwd(repoPath).quiet();

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
    env: { GITLAB_TOKEN: undefined },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("Credentials saved to");
  expect(stderr).toContain(testConfigDir);
  const creds = await Bun.file(testCredsFile).json();
  expect(creds.token).toBe("mytoken");
});

test("loads credentials from settings file when env vars are not set", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
});

test("saves credentials to macOS Library path when on darwin", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  const { exitCode } = await run([], {
    platform: "darwin",
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome, XDG_CONFIG_HOME: undefined },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpHome, "Library", "Application Support", "gitlab-rebase", "credentials.json"))).toBe(true);
});

test("saves credentials to APPDATA path when on win32", async () => {
  const tmpAppData = mkdtempSync("/tmp/gitlab-rebase-test-appdata-");
  const { exitCode } = await run([], {
    platform: "win32",
    env: { GITLAB_TOKEN: undefined, APPDATA: tmpAppData, XDG_CONFIG_HOME: undefined },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpAppData, "gitlab-rebase", "credentials.json"))).toBe(true);
});

test("saves credentials to XDG_CONFIG_HOME path when on linux", async () => {
  const tmpXdg = mkdtempSync("/tmp/gitlab-rebase-test-xdg-");
  const { exitCode } = await run([], {
    platform: "linux",
    env: { GITLAB_TOKEN: undefined, XDG_CONFIG_HOME: tmpXdg },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpXdg, "gitlab-rebase", "credentials.json"))).toBe(true);
});

test("env var takes precedence over saved credentials", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: "envtoken" },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
  expect(stderr).not.toContain("Credentials saved");
});

// --- .netrc tests ---

test("reads token from .netrc matching the GITLAB_URL hostname", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  await Bun.write(
    join(tmpHome, ".netrc"),
    "machine localhost\nlogin user@example.com\npassword netrctoken\n"
  );
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
});

test("env var takes precedence over .netrc token", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  await Bun.write(
    join(tmpHome, ".netrc"),
    "machine localhost\npassword netrctoken\n"
  );
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: "envtoken", HOME: tmpHome },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
  expect(stderr).not.toContain("Credentials saved");
});

test(".netrc takes precedence over saved credentials", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  await Bun.write(
    join(tmpHome, ".netrc"),
    "machine localhost\npassword netrctoken\n"
  );
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN is not set");
  expect(stderr).not.toContain("Credentials saved");
});

test("prompts when .netrc does not contain a matching machine entry", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  await Bun.write(
    join(tmpHome, ".netrc"),
    "machine other.example.com\npassword othertoken\n"
  );
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN is not set");
});

test("prompts when .netrc machine entry has no password field", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  await Bun.write(
    join(tmpHome, ".netrc"),
    "machine localhost\nlogin user@example.com\n"
  );
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN is not set");
});

test("proceeds normally when .netrc file does not exist", async () => {
  const tmpHome = mkdtempSync("/tmp/gitlab-rebase-test-home-");
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN is not set");
});

// --- cache tests ---

test("merges cached older MRs with fresh ones", async () => {
  const { repoPath, mergedShas, headSha } = await makeRepoWithMergedAndNewFeature(2);
  const tmpDir = mkdtempSync("/tmp/gitlab-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "old commit" }]);
  await run([], { cwd: repoPath, env: { GITLAB_CACHE_DIR: tmpDir } });

  // First run rebases the feature branch; reset it so the second run sees the same repo state.
  await Bun.$`git reset --hard ${headSha}`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 2, title: "New MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(2, [{ id: mergedShas[1]!, short_id: mergedShas[1]!.slice(0, 8), title: "new commit" }]);
  const { stdout, exitCode } = await run(["--verbose"], { cwd: repoPath, env: { GITLAB_CACHE_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("!1 Old MR");
  expect(stdout).toContain("!2 New MR");
});

test("fresh data replaces cached version of same MR", async () => {
  const { repoPath, mergedShas, headSha } = await makeRepoWithMergedAndNewFeature(1);
  const tmpDir = mkdtempSync("/tmp/gitlab-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old title", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "the commit" }]);
  await run([], { cwd: repoPath, env: { GITLAB_CACHE_DIR: tmpDir } });

  // First run rebases the feature branch; reset it so the second run sees the same repo state.
  await Bun.$`git reset --hard ${headSha}`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 1, title: "Updated title", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "the commit" }]);
  const { stdout, exitCode } = await run(["--verbose"], { cwd: repoPath, env: { GITLAB_CACHE_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Updated title");
  expect(stdout).not.toContain("Old title");
});

// --- error handling tests ---

test("handles invalid JSON in credentials file by prompting again", async () => {
  mkdirSync(dirname(testCredsFile), { recursive: true });
  writeFileSync(testCredsFile, "not valid json{{{");

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined },
    stdin: "mytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN is not set");
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
  // Commits are fetched for every MR returned by the API, regardless of filtering.
  mockMRs = [{ iid: 99, title: "Some MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommitsErrorIid = 99;

  const { stderr, exitCode } = await run([]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("500");
});

test("exits with error when cwd is not a git repository", async () => {
  const nonGitDir = mkdtempSync("/tmp/gitlab-rebase-not-git-");
  const { stderr, exitCode } = await run([], { cwd: nonGitDir });
  expect(exitCode).not.toBe(0);
  expect(stderr.trim()).toBe("Not a Git repository. `gitlab-rebase` must be used inside a Git repo.");
});

test("exits with error when remote exists but has no URL configured", async () => {
  const repoPath = await makeGitRepo();
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

test("exits when GITLAB_TOKEN is set and stdinLines are omitted", async () => {
  // No token prompt → default readline is never opened; process must still exit.
  const { exitCode } = await run([], { omitStdin: true });
  expect(exitCode).toBe(0);
});

test("proceeds gracefully when credentials cannot be saved", async () => {
  // Place a file where the credentials directory should be so mkdir fails
  const blockingBase = mkdtempSync("/tmp/gitlab-rebase-block-");
  writeFileSync(join(blockingBase, "gitlab-rebase"), "blocker");

  const { stderr, exitCode } = await run([], {
    env: {
      GITLAB_TOKEN: undefined,
      XDG_CONFIG_HOME: blockingBase,
    },
    stdin: "mytoken\n",
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

// --- target branch and base commit tests ---

async function makeRepoWithDivergedBranch(): Promise<{
  repoPath: string;
  mainCommitShas: [string, string];
  featureCommitSha: string;
}> {
  const repoPath = await makeGitRepo();
  // Create a feature branch from the initial commit
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "feature work"`.cwd(repoPath).quiet();
  const featureCommitSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  // Add two new commits on main (after feature branched off)
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "landed on main 1"`.cwd(repoPath).quiet();
  const sha1 = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git commit --allow-empty -m "landed on main 2"`.cwd(repoPath).quiet();
  const sha2 = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();
  return { repoPath, mainCommitShas: [sha1, sha2], featureCommitSha };
}

// Feature branch with `mergedCount` commits (available for MR matching) plus
// one trailing "new work" commit that remains after the rebase. Main has one
// extra commit on top of the branch point so there is always a rebase target.
async function makeRepoWithMergedAndNewFeature(mergedCount: number): Promise<{
  repoPath: string;
  mergedShas: string[];
  headSha: string;
}> {
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  const mergedShas: string[] = [];
  for (let i = 0; i < mergedCount; i++) {
    await Bun.$`git commit --allow-empty -m "merged commit ${i + 1}"`.cwd(repoPath).quiet();
    mergedShas.push((await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim());
  }
  await Bun.$`git commit --allow-empty -m "new work"`.cwd(repoPath).quiet();
  const headSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "landed on main"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();
  return { repoPath, mergedShas, headSha };
}

test("defaults target branch to main", async () => {
  const { repoPath, mergedShas } = await makeRepoWithMergedAndNewFeature(1);
  mockMRs = [
    { iid: 1, title: "MR on main", target_branch: "main", merged_at: RECENT, updated_at: RECENT },
    { iid: 2, title: "Unrelated MR", target_branch: "release", merged_at: RECENT, updated_at: RECENT },
  ];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "feature work" }]);
  mockCommits.set(2, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "feature work" }]);

  const { stdout, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("!1 MR on main");
  expect(stdout).not.toContain("!2 Unrelated MR");
});

test("accepts custom target branch as positional arg", async () => {
  // feature branches off main (initial commit); release adds a commit after
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "merged feature work"`.cwd(repoPath).quiet();
  const mergedSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git commit --allow-empty -m "new work"`.cwd(repoPath).quiet();
  await Bun.$`git checkout -b release main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "release commit"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 5, title: "Release MR", target_branch: "release", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(5, [{ id: mergedSha, short_id: mergedSha.slice(0, 8), title: "merged feature work" }]);

  const { stdout, exitCode } = await run(["release", "--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("!5 Release MR");
});

test("includes MR whose commit appears in the current branch", async () => {
  const { repoPath, mergedShas } = await makeRepoWithMergedAndNewFeature(1);
  mockMRs = [{ iid: 3, title: "Squash MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(3, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "squashed" }]);

  const { stdout, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("!3 Squash MR");
});

test("excludes MRs whose commits do not appear in the current branch", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  mockMRs = [{ iid: 9, title: "Old MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(9, [{ id: "a".repeat(40), short_id: "aaaaaaaa", title: "unrelated commit" }]);

  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("!9 Old MR");
});

test("excludes MRs where merged_at is before base commit date", async () => {
  const { repoPath, featureCommitSha } = await makeRepoWithDivergedBranch();
  // Commit is in the current branch, but merged_at is before base → should be excluded.
  mockMRs = [{ iid: 4, title: "Old merged MR", target_branch: "main", merged_at: OLD, updated_at: OLD }];
  mockCommits.set(4, [{ id: featureCommitSha, short_id: featureCommitSha.slice(0, 8), title: "feature work" }]);

  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("!4 Old merged MR");
});

test("exits with error when branch has no commits ahead of target", async () => {
  const repoPath = await makeGitRepo();
  // HEAD == merge-base with main → 0 current-branch commits
  const { stderr, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr.trim()).toBe("No commits on branch `main` ahead of `main`.");
});

test("exits with error when all commits have already been merged", async () => {
  const { repoPath, featureCommitSha } = await makeRepoWithDivergedBranch();
  mockMRs = [{ iid: 1, title: "Feature MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: featureCommitSha, short_id: featureCommitSha.slice(0, 8), title: "feature work" }]);

  const { stderr, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr.trim()).toBe("The 1 commit on branch `feature` has already been merged to `main`.");
});

test("exits with error when target branch does not exist", async () => {
  const repoPath = await makeGitRepo();

  const { stderr, exitCode } = await run(["nonexistent-branch"], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("nonexistent-branch");
});

// --- pagination tests ---

test("stops fetching when first page MRs are older than base commit date", async () => {
  mockMRs = [
    { iid: 1, title: "Old MR", target_branch: "main", merged_at: OLD, updated_at: OLD },
  ];
  mockCommits.set(1, []);

  const { exitCode } = await run([], { env: { GITLAB_PER_PAGE: "1" } });
  expect(exitCode).toBe(0);
  expect(mrPagesFetched).toBe(1);
});

test("paginates to fetch MRs until updated_at falls before base commit date", async () => {
  mockMRs = [
    { iid: 2, title: "Recent MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT },
    { iid: 1, title: "Old MR", target_branch: "main", merged_at: OLD, updated_at: OLD },
  ];
  mockCommits.set(2, []);
  mockCommits.set(1, []);

  const { exitCode } = await run([], { env: { GITLAB_PER_PAGE: "1" } });
  expect(exitCode).toBe(0);
  expect(mrPagesFetched).toBe(2);
});

// --- target branch update tests ---

const REBASE_SUMMARY =
  "Rebasing `feature` onto `main`. 0 commits have already been merged to `main`. Will rebase 1 commit.";
const DEFAULT_STDOUT = "Rebasing onto branch `main`.\n" + REBASE_SUMMARY;
// Final-frame ink SelectInput renders (ANSI-stripped). Because ink rewrites its
// view on each state change and we strip cursor-motion codes from stderr, only
// the final frame survives: "Update" highlighted if the user pressed Enter
// directly, "Skip" highlighted if they navigated down first.
const UPDATE_PROMPT_UPDATE_SELECTED =
  "Branch `main` is not up-to-date.\n" +
  "\n" +
  "❯ 1. Update branch `main` from remote `origin`\n" +
  "  2. Skip\n" +
  "\n" +
  "↑↓ to navigate · Enter to select\n";
const UPDATE_PROMPT_SKIP_SELECTED =
  "Branch `main` is not up-to-date.\n" +
  "\n" +
  "  1. Update branch `main` from remote `origin`\n" +
  "❯ 2. Skip\n" +
  "\n" +
  "↑↓ to navigate · Enter to select\n";
const UPDATE_SUCCESS =
  "Updating branch `main` from remote `origin`...\n" +
  "Branch `main` updated.\n";
const STASH_PROMPT_STASH_SELECTED =
  "You have uncommitted changes.\n" +
  "\n" +
  "❯ 1. Stash changes\n" +
  "  2. Skip\n" +
  "\n" +
  "↑↓ to navigate · Enter to select\n";
const STASH_PROMPT_SKIP_SELECTED =
  "You have uncommitted changes.\n" +
  "\n" +
  "  1. Stash changes\n" +
  "❯ 2. Skip\n" +
  "\n" +
  "↑↓ to navigate · Enter to select\n";
const STASH_PROGRESS = "Stashing changes...\n";
const REBASE_PROGRESS = "Rebasing 1 commit onto `main`...\n";
// git rebase prints "Rebasing (N/M)" per commit, then the final summary.
const REBASE_SUCCESS = "Rebasing (1/1)\nSuccessfully rebased and updated refs/heads/feature.\n";
// When baseSha equals target tip, git rebase --onto is a no-op.
const REBASE_UPTODATE = "Current branch feature is up to date.\n";

async function makeRepoWithRemoteAhead(): Promise<{
  repoPath: string;
  remoteNewSha: string;
}> {
  const remotePath = await makeGitRepo();
  const localPath = mkdtempSync("/tmp/gitlab-rebase-test-");
  await Bun.$`git clone ${remotePath} ${localPath}`.quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(localPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(localPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(localPath).quiet();
  await Bun.$`git checkout -b feature`.cwd(localPath).quiet();
  await Bun.$`git commit --allow-empty -m "feature work"`.cwd(localPath).quiet();
  // Push a new commit to the remote *after* cloning — local has no knowledge of it yet.
  await Bun.$`git commit --allow-empty -m "new remote commit"`.cwd(remotePath).quiet();
  const remoteNewSha = (await Bun.$`git rev-parse HEAD`.cwd(remotePath).text()).trim();
  return { repoPath: localPath, remoteNewSha };
}

test("shows no update prompt when target has no upstream tracking", async () => {
  const { stderr, stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe(REBASE_PROGRESS + REBASE_SUCCESS);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
});

test("shows no update prompt when target is already up to date with remote", async () => {
  const remotePath = await makeGitRepo();
  const localPath = mkdtempSync("/tmp/gitlab-rebase-test-");
  await Bun.$`git clone ${remotePath} ${localPath}`.quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(localPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(localPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(localPath).quiet();
  await Bun.$`git checkout -b feature`.cwd(localPath).quiet();
  await Bun.$`git commit --allow-empty -m "feature work"`.cwd(localPath).quiet();

  const { stderr, stdout, exitCode } = await run([], { cwd: localPath });
  expect(exitCode).toBe(0);
  // feature is already on top of main, so rebase is a no-op
  expect(stderr).toBe(REBASE_PROGRESS + REBASE_UPTODATE);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
});

test("shows update prompt when target branch is behind remote", async () => {
  const { repoPath } = await makeRepoWithRemoteAhead();
  const { stderr, stdout, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER });
  expect(exitCode).toBe(0);
  expect(stderr).toBe(UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + REBASE_PROGRESS + REBASE_SUCCESS);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
});

test("updates target branch when user selects Update", async () => {
  const { repoPath, remoteNewSha } = await makeRepoWithRemoteAhead();
  const { stderr, stdout, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER });
  expect(exitCode).toBe(0);
  expect(stderr).toBe(UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + REBASE_PROGRESS + REBASE_SUCCESS);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
  const localMainSha = (await Bun.$`git rev-parse main`.cwd(repoPath).text()).trim();
  expect(localMainSha).toBe(remoteNewSha);
});

test("updates checked-out target branch so index and worktree match remote", async () => {
  const remotePath = await makeGitRepo();
  const localPath = mkdtempSync("/tmp/gitlab-rebase-test-");
  await Bun.$`git clone ${remotePath} ${localPath}`.quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(localPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(localPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(localPath).quiet();
  await Bun.$`git commit --allow-empty -m "new remote commit"`.cwd(remotePath).quiet();
  const remoteNewSha = (await Bun.$`git rev-parse HEAD`.cwd(remotePath).text()).trim();

  const { stderr, stdout, exitCode } = await run([], { cwd: localPath, inkStdin: KEY_ENTER });
  expect(exitCode).not.toBe(0);
  expect(stderr).toBe(
    UPDATE_PROMPT_UPDATE_SELECTED +
      UPDATE_SUCCESS +
      "No commits on branch `main` ahead of `main`.\n",
  );
  expect(stdout).toBe("Rebasing onto branch `main`.\n");
  expect((await Bun.$`git rev-parse main`.cwd(localPath).text()).trim()).toBe(remoteNewSha);
  expect((await Bun.$`git rev-parse HEAD`.cwd(localPath).text()).trim()).toBe(remoteNewSha);
  const wtClean = await Bun.$`git diff --quiet && git diff --cached --quiet`
    .cwd(localPath)
    .quiet()
    .nothrow();
  expect(wtClean.exitCode).toBe(0);
});

test("skips update when user selects Skip", async () => {
  const { repoPath, remoteNewSha } = await makeRepoWithRemoteAhead();
  const localMainShaBefore = (await Bun.$`git rev-parse main`.cwd(repoPath).text()).trim();
  const { stderr, stdout, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_DOWN + KEY_ENTER });
  expect(exitCode).toBe(0);
  // main tip == baseSha here, so rebase --onto is a no-op
  expect(stderr).toBe(UPDATE_PROMPT_SKIP_SELECTED + REBASE_PROGRESS + REBASE_UPTODATE);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
  const localMainShaAfter = (await Bun.$`git rev-parse main`.cwd(repoPath).text()).trim();
  expect(localMainShaAfter).toBe(localMainShaBefore);
  expect(localMainShaAfter).not.toBe(remoteNewSha);
});

test("exits with error when target update fails due to diverged branches", async () => {
  const { repoPath } = await makeRepoWithRemoteAhead();
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "local only commit"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();
  const { stderr, stdout, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER });
  expect(exitCode).not.toBe(0);
  expect(stderr).toBe(
    UPDATE_PROMPT_UPDATE_SELECTED +
      "Cannot update branch `main`: it has diverged from branch `origin/main`.\n"
  );
  expect(stdout).toBe("Rebasing onto branch `main`.\n");
});

// --- stash prompt tests ---

async function makeRepoWithRemoteAheadAndDirty(): Promise<{
  repoPath: string;
  remoteNewSha: string;
}> {
  const result = await makeRepoWithRemoteAhead();
  writeFileSync(join(result.repoPath, "dirty.txt"), "dirty content");
  await Bun.$`git add dirty.txt`.cwd(result.repoPath).quiet();
  return result;
}

test("shows stash prompt before update prompt when dirty changes exist", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { stderr, exitCode } = await run([], {
    cwd: repoPath,
    inkStdin: KEY_ENTER + KEY_ENTER,
  });
  expect(exitCode).toBe(0);
  // git stash output includes a dynamic SHA, so check the static parts around it
  expect(stderr.startsWith(STASH_PROMPT_STASH_SELECTED + STASH_PROGRESS)).toBe(true);
  expect(stderr.endsWith(UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + REBASE_PROGRESS + REBASE_SUCCESS)).toBe(true);
});

test("stashes changes when user selects Stash", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { exitCode } = await run([], {
    cwd: repoPath,
    inkStdin: KEY_ENTER + KEY_ENTER,
  });
  expect(exitCode).toBe(0);
  const stashList = (await Bun.$`git stash list`.cwd(repoPath).text()).trim();
  expect(stashList).not.toBe("");
});

test("does not stash when user selects Skip on stash prompt", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { stderr, exitCode } = await run([], {
    cwd: repoPath,
    inkStdin: KEY_DOWN + KEY_ENTER + KEY_ENTER,
  });
  // Staged changes were not stashed, so git rebase refuses to run.
  expect(exitCode).not.toBe(0);
  expect(stderr).toBe(
    STASH_PROMPT_SKIP_SELECTED +
    UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS +
    REBASE_PROGRESS +
    "error: cannot rebase: Your index contains uncommitted changes.\n" +
    "error: Please commit or stash them.\n",
  );
  // Nothing was stashed despite the failure.
  const stashList = (await Bun.$`git stash list`.cwd(repoPath).text()).trim();
  expect(stashList).toBe("");
});

test("no stash prompt shown when working tree is clean", async () => {
  const { repoPath } = await makeRepoWithRemoteAhead();
  const { stderr, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER });
  expect(exitCode).toBe(0);
  expect(stderr).toBe(UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + REBASE_PROGRESS + REBASE_SUCCESS);
});

// --- rebase tests ---

test("rebases current branch onto target after listing MRs", async () => {
  // defaultTestCwd: feature diverges from main at the initial commit; main has 2 extra commits.
  const mainTip = defaultMainShas[1]!;
  const { stdout, stderr, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(DEFAULT_STDOUT);
  expect(stderr).toBe(REBASE_PROGRESS + REBASE_SUCCESS);
  // After rebase, feature's parent should be main's tip.
  const featureParent = (await Bun.$`git rev-parse HEAD~1`.cwd(defaultTestCwd).text()).trim();
  expect(featureParent).toBe(mainTip);
});

test("skips already-merged commits and rebases only the remaining ones", async () => {
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "merged commit"`.cwd(repoPath).quiet();
  const mergedSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git commit --allow-empty -m "new work"`.cwd(repoPath).quiet();
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "landed on main"`.cwd(repoPath).quiet();
  const mainSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 1, title: "Merged MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedSha, short_id: mergedSha.slice(0, 8), title: "merged commit" }]);

  const { stdout, stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    "Rebasing onto branch `main`.\n" +
    "Rebasing `feature` onto `main`. 1 commit has already been merged to `main`. Will rebase 1 commit.\n" +
    "!1 Merged MR\n" +
    `  ${mergedSha.slice(0, 8)} merged commit\n`,
  );
  expect(stderr).toBe(REBASE_PROGRESS + REBASE_SUCCESS);
  // After rebase, "new work" is on top of main's new commit; "merged commit" was dropped.
  const headParent = (await Bun.$`git rev-parse HEAD~1`.cwd(repoPath).text()).trim();
  expect(headParent).toBe(mainSha);
  const headMsg = (await Bun.$`git log -1 --format=%s HEAD`.cwd(repoPath).text()).trim();
  expect(headMsg).toBe("new work");
});

test("exits with error when git rebase encounters conflicts", async () => {
  const repoPath = await makeGitRepo();
  // Create conflicting file on main
  await Bun.write(join(repoPath, "conflict.txt"), "main content\n");
  await Bun.$`git add conflict.txt`.cwd(repoPath).quiet();
  await Bun.$`git commit -m "main adds conflict.txt"`.cwd(repoPath).quiet();
  // Create feature branch from before main's commit with conflicting change
  await Bun.$`git checkout -b feature HEAD~1`.cwd(repoPath).quiet();
  await Bun.write(join(repoPath, "conflict.txt"), "feature content\n");
  await Bun.$`git add conflict.txt`.cwd(repoPath).quiet();
  await Bun.$`git commit -m "feature adds conflict.txt"`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 1, title: "Conflict MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, []);

  const { stderr, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  // git rebase aborts and its output includes CONFLICT
  expect(stderr).toContain("CONFLICT");
  // Clean up mid-rebase state so the temp dir is usable
  await Bun.$`git rebase --abort`.cwd(repoPath).quiet().nothrow();
});

test("exits with error when upstream tracking branch has unexpected format", async () => {
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "feature work"`.cwd(repoPath).quiet();
  // Configure main's upstream as a local branch (remote ".") — git rev-parse --abbrev-ref
  // then returns just "feature" (no slash), which triggers the upstream format validation.
  await Bun.$`git config branch.main.remote .`.cwd(repoPath).quiet();
  await Bun.$`git config branch.main.merge refs/heads/feature`.cwd(repoPath).quiet();
  const { stderr, stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stdout).toBe("Rebasing onto branch `main`.\n");
  expect(stderr).toBe("Unexpected upstream format: feature\n");
});
