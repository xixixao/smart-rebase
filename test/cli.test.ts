import { test, expect, afterAll, beforeAll, beforeEach, jest } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { main } from "../src/index";
import { GITLAB_TOKEN_URL } from "../src/auth";

const testDataDir = mkdtempSync("/tmp/smart-rebase-test-data-");
const testCredsFile = join(testDataDir, "credentials.json");

// Dates relative to the fixed initial commit date ("2020-01-01") used in makeGitRepo.
const RECENT = "2021-01-01T00:00:00+00:00"; // after base → MR passes merged_at filter
const OLD = "2019-01-01T00:00:00+00:00"; // before base → MR fails merged_at filter

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
      if (mockMRsError)
        return Response.json([
          { iid: "not-a-number", title: "Bad", target_branch: "main", merged_at: null, updated_at: OLD },
        ]);
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
  rmSync(testDataDir, { recursive: true, force: true });
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
  try {
    rmSync(testCredsFile);
  } catch {}
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
    if (
      keys.slice(i, i + 3) === "\x1B[A" ||
      keys.slice(i, i + 3) === "\x1B[B" ||
      keys.slice(i, i + 3) === "\x1B[C" ||
      keys.slice(i, i + 3) === "\x1B[D"
    ) {
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
    inkStdin?: string;
    cwd?: string;
    platform?: NodeJS.Platform;
    stdIsTTY?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const spyOnGetter = jest.spyOn as (
    obj: NodeJS.Process,
    key: "platform",
    accessor: "get",
  ) => { mockReturnValue: (v: NodeJS.Platform) => void; mockRestore: () => void };
  const platformSpy = spyOnGetter(process, "platform", "get");
  platformSpy.mockReturnValue(opts.platform ?? "linux");

  const testEnv: Record<string, string | undefined> = {
    GITLAB_TOKEN: "testtoken",
    GITLAB_URL,
    GITLAB_PROJECT: "testgroup/testrepo",
    GITLAB_DATA_DIR: mkdtempSync("/tmp/smart-rebase-test-data-"),
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

  const inkStream = makeInkStdinStream(opts.inkStdin ?? "");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  const origStdoutIsTTY = process.stdout.isTTY;
  const origStderrIsTTY = process.stderr.isTTY;

  (process.stdout as NodeJS.WriteStream & { write: unknown }).write = (chunk: string | Uint8Array) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  (process.stderr as NodeJS.WriteStream & { write: unknown }).write = (chunk: string | Uint8Array) => {
    stderrBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutBuffer += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    stderrBuffer += args.map(String).join(" ") + "\n";
  };
  (process.stderr as NodeJS.WriteStream & { isTTY: unknown }).isTTY = opts.stdIsTTY ?? false;
  (process.stdout as NodeJS.WriteStream & { isTTY: unknown }).isTTY = opts.stdIsTTY ?? false;

  let exitCode = 0;
  try {
    await main(args, { cwd: opts.cwd ?? defaultTestCwd, stdin: inkStream as unknown as NodeJS.ReadableStream });
  } catch (e: unknown) {
    exitCode = 1;
    stderrBuffer += (e instanceof Error ? e.message : String(e)) + "\n";
  } finally {
    platformSpy.mockRestore();
    (process.stdout as NodeJS.WriteStream & { write: unknown }).write = origStdoutWrite;
    (process.stderr as NodeJS.WriteStream & { write: unknown }).write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
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

async function makeBrowserScript(): Promise<{ browserScript: string; browserLog: string }> {
  const tmpDir = mkdtempSync("/tmp/smart-rebase-test-");
  const browserScript = join(tmpDir, "browser.sh");
  const browserLog = join(tmpDir, "browser-url.txt");
  await Bun.write(browserScript, `#!/bin/sh\necho "$1" > "${browserLog}"\n`);
  await Bun.$`chmod +x ${browserScript}`.quiet();
  return { browserScript, browserLog };
}

async function makeGitRepo(
  remotes: Record<string, string> = {},
  options: { tracking?: boolean } = {},
): Promise<string> {
  const repoPath = mkdtempSync("/tmp/smart-rebase-test-");
  await Bun.$`git init -b main`.cwd(repoPath).quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(repoPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(repoPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(repoPath).quiet();
  // Fixed date so the base commit date is always "2020-01-01T00:00:00+00:00",
  // making mock MR dates predictable (RECENT = 2021, OLD = 2019).
  const D = "2020-01-01T00:00:00+00:00";
  await Bun.$`git commit --allow-empty -m "Initial commit"`
    .cwd(repoPath)
    .env({ ...process.env, GIT_AUTHOR_DATE: D, GIT_COMMITTER_DATE: D })
    .quiet();
  if (options.tracking !== false) {
    await addMainTrackingRemote(repoPath, []);
  }
  for (const [name, url] of Object.entries(remotes)) {
    await Bun.$`git remote add ${name} ${url}`.cwd(repoPath).quiet();
  }
  return repoPath;
}

async function addMainTrackingRemote(repoPath: string, extraBranches: string[]): Promise<void> {
  const existing = (await Bun.$`git remote`.cwd(repoPath).quiet().text()).trim().split("\n").filter(Boolean);
  if (!existing.includes("origin")) {
    const bareOrigin = mkdtempSync("/tmp/smart-rebase-test-origin-");
    await Bun.$`git init --bare -b main`.cwd(bareOrigin).quiet();
    await Bun.$`git remote add origin ${bareOrigin}`.cwd(repoPath).quiet();
    await Bun.$`git push -u origin main`.cwd(repoPath).quiet();
  }
  for (const branch of extraBranches) {
    await Bun.$`git push -u origin ${branch}`.cwd(repoPath).quiet();
  }
}

// --- flag tests ---

test("verbose defaults to false", async () => {
  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("Verbose mode enabled");
});

test("uses colors instead of backticks when stdout is a TTY", async () => {
  const { stdout, exitCode } = await run([], { stdIsTTY: true });
  expect(exitCode).toBe(0);
  // ANSI codes are stripped here; names appear without backtick delimiters
  expect(stdout.trim()).toBe("Rebasing feature onto main. Will rebase 1 commit.");
});

test("--verbose flag is recognised", async () => {
  const { stdout, exitCode } = await run(["--verbose"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Rebasing `feature` onto `main`. Will rebase 1 commit.\n");
});

test("-v alias works", async () => {
  const { stdout, exitCode } = await run(["-v"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Rebasing `feature` onto `main`. Will rebase 1 commit.\n");
});

test("unknown flag exits with non-zero code", async () => {
  const { exitCode } = await run(["--unknown"]);
  expect(exitCode).not.toBe(0);
});

test("--verbose prints HEAD short sha", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  const expectedSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stderr).toContain(`Current commit: \`${expectedSha}\``);
});

// --- auth tests ---

test("runs without auth prompts when env vars are set", async () => {
  const { stderr, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN");
});

test("prompts for token when GITLAB_TOKEN is not set", async () => {
  const { stderr, exitCode } = await run([], { env: { GITLAB_TOKEN: undefined }, inkStdin: "mytoken\r" });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN");
  expect(stderr).toContain("gitlab.com");
});

test("token prompt shows GitLab URL with api scope", async () => {
  const { stderr } = await run([], { env: { GITLAB_TOKEN: undefined }, inkStdin: "mytoken\r" });
  expect(stderr).toContain(GITLAB_TOKEN_URL);
});

test("opens browser when user presses Enter on token prompt", async () => {
  const { browserScript, browserLog } = await makeBrowserScript();
  const { exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: browserScript },
    inkStdin: "\rmyfinaltoken\r",
  });
  expect(exitCode).toBe(0);
  const openedUrl = await Bun.file(browserLog).text();
  expect(openedUrl.trim()).toBe(GITLAB_TOKEN_URL);
});

test("continues normally when browser command fails to launch", async () => {
  const { exitCode, stderr } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: "false" },
    inkStdin: "\rmytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("Enter your GitLab API token");
});

test("does not open browser when token is pasted directly", async () => {
  const { browserScript, browserLog } = await makeBrowserScript();
  const { exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, BROWSER: browserScript },
    inkStdin: "pastedtoken\r",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(browserLog)).toBe(false);
});

test("accepts token with surrounding whitespace", async () => {
  const { exitCode } = await run([], { env: { GITLAB_TOKEN: undefined }, inkStdin: "  mytoken  \r" });
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

  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("!1 Add feature");
  expect(stderr).toContain(`${mergedShas[0]!.slice(0, 8)} Implement feature`);
  expect(stderr).toContain("!2 Fix bug");
  expect(stderr).toContain(`${mergedShas[1]!.slice(0, 8)} Fix the bug`);
  expect(stderr).toContain(`${mergedShas[1]!.slice(0, 8)} Add test for fix`);
});

test("outputs only the rebase summary when there are no merged MRs", async () => {
  const { stdout, exitCode } = await run([]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("Rebasing `feature` onto `main`. Will rebase 1 commit.");
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
  const { stderr, exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

test("detects project from origin remote", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  // Keep the fetchable bare remote (main's upstream) under another name so the
  // target-branch update check still works; origin holds the GitLab URL.
  await Bun.$`git remote rename origin bare`.cwd(repoPath).quiet();
  await Bun.$`git remote add origin git@gitlab.com:mygroup/myproject.git`.cwd(repoPath).quiet();

  const { exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("mygroup/myproject");
});

test("detects project from the sole remote when it is not named origin", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  // The sole remote must be fetchable (it is main's upstream) *and* have a
  // GitLab-looking URL, so host the bare repo under a gitlab.com/… path.
  const barePath = join(mkdtempSync("/tmp/smart-rebase-test-"), "gitlab.com", "org", "upstream-project");
  mkdirSync(barePath, { recursive: true });
  await Bun.$`git init --bare -b main ${barePath}`.quiet();
  await Bun.$`git remote rename origin upstream`.cwd(repoPath).quiet();
  await Bun.$`git remote set-url upstream ${barePath}`.cwd(repoPath).quiet();
  await Bun.$`git push upstream main`.cwd(repoPath).quiet();

  const { exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("org/upstream-project");
});

test("uses origin when both origin and another remote exist", async () => {
  const { repoPath } = await makeRepoWithDivergedBranch();
  // Keep the fetchable bare remote (main's upstream) under another name; the
  // GitLab URLs go on origin and a second remote.
  await Bun.$`git remote rename origin bare`.cwd(repoPath).quiet();
  await Bun.$`git remote add origin git@gitlab.com:maingroup/mainproject.git`.cwd(repoPath).quiet();
  await Bun.$`git remote add fork git@gitlab.com:forkgroup/forkproject.git`.cwd(repoPath).quiet();

  const { exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).toBe(0);
  expect(lastRequestedProject).toBe("maingroup/mainproject");
});

test("errors when multiple remotes exist and none is named origin", async () => {
  const repoPath = await makeGitRepo({ foo: "git@gitlab.com:foo/project.git", bar: "git@gitlab.com:bar/project.git" });

  const { stderr, exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

// --- credentials storage tests ---

test("saves credentials to settings file when prompted and prints the path", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, GITLAB_DATA_DIR: testDataDir },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GitLab token saved to");
  expect(stderr).toContain(testDataDir);
  const creds = await Bun.file(testCredsFile).json();
  expect(creds.token).toBe("mytoken");
});

test("loads credentials from settings file when env vars are not set", async () => {
  mkdirSync(testDataDir, { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));

  const { stderr, exitCode } = await run([], { env: { GITLAB_TOKEN: undefined, GITLAB_DATA_DIR: testDataDir } });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN` is not set");
});

test("saves credentials to macOS Library path when on darwin", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  const { exitCode } = await run([], {
    platform: "darwin",
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome, GITLAB_DATA_DIR: undefined },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpHome, "Library", "Application Support", "smart-rebase", "credentials.json"))).toBe(true);
});

test("saves credentials to APPDATA path when on win32", async () => {
  const tmpAppData = mkdtempSync("/tmp/smart-rebase-test-appdata-");
  const { exitCode } = await run([], {
    platform: "win32",
    env: { GITLAB_TOKEN: undefined, APPDATA: tmpAppData, GITLAB_DATA_DIR: undefined },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpAppData, "smart-rebase", "credentials.json"))).toBe(true);
});

test("saves credentials to XDG_CONFIG_HOME path when on linux", async () => {
  const tmpXdg = mkdtempSync("/tmp/smart-rebase-test-xdg-");
  const { exitCode } = await run([], {
    platform: "linux",
    env: { GITLAB_TOKEN: undefined, XDG_CONFIG_HOME: tmpXdg, GITLAB_DATA_DIR: undefined },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(existsSync(join(tmpXdg, "smart-rebase", "credentials.json"))).toBe(true);
});

test("env var takes precedence over saved credentials", async () => {
  mkdirSync(testDataDir, { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));

  const { stderr, exitCode } = await run([], { env: { GITLAB_TOKEN: "envtoken", GITLAB_DATA_DIR: testDataDir } });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN` is not set");
  expect(stderr).not.toContain("GitLab token saved");
});

// --- .netrc tests ---

test("reads token from .netrc matching the GITLAB_URL hostname", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  await Bun.write(join(tmpHome, ".netrc"), "machine localhost\nlogin user@example.com\npassword netrctoken\n");
  const { stderr, exitCode } = await run([], { env: { GITLAB_TOKEN: undefined, HOME: tmpHome } });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN` is not set");
});

test("env var takes precedence over .netrc token", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  await Bun.write(join(tmpHome, ".netrc"), "machine localhost\npassword netrctoken\n");
  const { stderr, exitCode } = await run([], { env: { GITLAB_TOKEN: "envtoken", HOME: tmpHome } });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN` is not set");
  expect(stderr).not.toContain("GitLab token saved");
});

test(".netrc takes precedence over saved credentials", async () => {
  mkdirSync(testDataDir, { recursive: true });
  await Bun.write(testCredsFile, JSON.stringify({ token: "savedtoken" }));
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  await Bun.write(join(tmpHome, ".netrc"), "machine localhost\npassword netrctoken\n");
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome, GITLAB_DATA_DIR: testDataDir },
  });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("GITLAB_TOKEN` is not set");
  expect(stderr).not.toContain("GitLab token saved");
});

test("prompts when .netrc does not contain a matching machine entry", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  await Bun.write(join(tmpHome, ".netrc"), "machine other.example.com\npassword othertoken\n");
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN` is not set");
});

test("prompts when .netrc machine entry has no password field", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  await Bun.write(join(tmpHome, ".netrc"), "machine localhost\nlogin user@example.com\n");
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN` is not set");
});

test("proceeds normally when .netrc file does not exist", async () => {
  const tmpHome = mkdtempSync("/tmp/smart-rebase-test-home-");
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, HOME: tmpHome },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN` is not set");
});

// --- cache tests ---

test("merges cached older MRs with fresh ones", async () => {
  const { repoPath, mergedShas, headSha } = await makeRepoWithMergedAndNewFeature(2);
  const tmpDir = mkdtempSync("/tmp/smart-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "old commit" }]);
  await run([], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });

  // First run rebases the feature branch; reset it so the second run sees the same repo state.
  await Bun.$`git reset --hard ${headSha}`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 2, title: "New MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(2, [{ id: mergedShas[1]!, short_id: mergedShas[1]!.slice(0, 8), title: "new commit" }]);
  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stderr).toContain("!1 Old MR");
  expect(stderr).toContain("!2 New MR");
});

test("fresh data replaces cached version of same MR", async () => {
  const { repoPath, mergedShas, headSha } = await makeRepoWithMergedAndNewFeature(1);
  const tmpDir = mkdtempSync("/tmp/smart-rebase-cache-test-");

  mockMRs = [{ iid: 1, title: "Old title", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "the commit" }]);
  await run([], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });

  // First run rebases the feature branch; reset it so the second run sees the same repo state.
  await Bun.$`git reset --hard ${headSha}`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 1, title: "Updated title", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "the commit" }]);
  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });

  expect(exitCode).toBe(0);
  expect(stderr).toContain("Updated title");
  expect(stderr).not.toContain("Old title");
});

// --- error handling tests ---

test("handles invalid JSON in credentials file by prompting again", async () => {
  mkdirSync(testDataDir, { recursive: true });
  writeFileSync(testCredsFile, "not valid json{{{");

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, GITLAB_DATA_DIR: testDataDir },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_TOKEN` is not set");
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
  const nonGitDir = mkdtempSync("/tmp/smart-rebase-not-git-");
  const { stderr, exitCode } = await run([], { cwd: nonGitDir });
  expect(exitCode).not.toBe(0);
  expect(stderr.trim()).toBe("Not a Git repository. `smart-rebase` must be used inside a Git repo.");
});

test("exits with error when remote exists but has no URL configured", async () => {
  const repoPath = await makeGitRepo();
  // Keep main's upstream fetchable under another name; origin (the remote
  // project detection picks) is left without a URL.
  await Bun.$`git remote rename origin bare`.cwd(repoPath).quiet();
  await Bun.$`git remote add origin git@gitlab.com:foo/bar`.cwd(repoPath).quiet();
  await Bun.$`git config --unset remote.origin.url`.cwd(repoPath).quiet();

  const { stderr, exitCode } = await run([], { cwd: repoPath, env: { GITLAB_PROJECT: undefined } });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("GITLAB_PROJECT");
});

test("uses default data directory when GITLAB_DATA_DIR is not set", async () => {
  const homeDir = mkdtempSync("/tmp/smart-rebase-home-");
  const { exitCode } = await run([], {
    env: { GITLAB_DATA_DIR: undefined, HOME: homeDir, XDG_CONFIG_HOME: undefined },
  });
  expect(exitCode).toBe(0);
  // Platform defaults to "linux" in tests, so falls back to ~/.config/smart-rebase
  expect(existsSync(join(homeDir, ".config", "smart-rebase"))).toBe(true);
});

test("exits normally when GITLAB_TOKEN is set without needing stdin input", async () => {
  const { exitCode } = await run([]);
  expect(exitCode).toBe(0);
});

test("fails with helpful message when credentials cannot be saved", async () => {
  // Place a regular file at the path that would be used as the data directory so mkdir fails
  const blockingBase = mkdtempSync("/tmp/smart-rebase-block-");
  const blockingDataDir = join(blockingBase, "smart-rebase");
  writeFileSync(blockingDataDir, "blocker");

  const { stderr, exitCode } = await run([], {
    env: { GITLAB_TOKEN: undefined, GITLAB_DATA_DIR: blockingDataDir },
    inkStdin: "mytoken\r",
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("Failed to save credentials");
  expect(stderr).toContain(blockingDataDir);
  expect(stderr).toContain("GITLAB_DATA_DIR");
});

test("handles corrupted cache file gracefully", async () => {
  const dataDir = mkdtempSync("/tmp/smart-rebase-cache-corrupt-");
  const key = `${GITLAB_URL}:testgroup/testrepo`.replace(/[^a-zA-Z0-9.-]/g, "_");
  writeFileSync(join(dataDir, `${key}.json`), "corrupted{{{{");

  const { exitCode } = await run([], { env: { GITLAB_DATA_DIR: dataDir } });
  expect(exitCode).toBe(0);
});

test("fails with helpful message when cache cannot be written", async () => {
  // Place a regular file at the path that would be used as the data directory so mkdir fails
  const blockingBase = mkdtempSync("/tmp/smart-rebase-block-");
  const blockingDataDir = join(blockingBase, "smart-rebase");
  writeFileSync(blockingDataDir, "blocker");

  const { stderr, exitCode } = await run([], { env: { GITLAB_DATA_DIR: blockingDataDir } });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("Failed to write cache");
  expect(stderr).toContain(blockingDataDir);
  expect(stderr).toContain("GITLAB_DATA_DIR");
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
async function makeRepoWithMergedAndNewFeature(
  mergedCount: number,
): Promise<{ repoPath: string; mergedShas: string[]; headSha: string }> {
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

  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("!1 MR on main");
  expect(stderr).not.toContain("!2 Unrelated MR");
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
  await addMainTrackingRemote(repoPath, ["release"]);

  mockMRs = [{ iid: 5, title: "Release MR", target_branch: "release", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(5, [{ id: mergedSha, short_id: mergedSha.slice(0, 8), title: "merged feature work" }]);

  const { stderr, exitCode } = await run(["release", "--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("!5 Release MR");
});

test("includes MR whose commit appears in the current branch", async () => {
  const { repoPath, mergedShas } = await makeRepoWithMergedAndNewFeature(1);
  mockMRs = [{ iid: 3, title: "Squash MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(3, [{ id: mergedShas[0]!, short_id: mergedShas[0]!.slice(0, 8), title: "squashed" }]);

  const { stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("!3 Squash MR");
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

test("prints message and exits cleanly when branch has no commits ahead of target", async () => {
  const repoPath = await makeGitRepo();
  // HEAD == merge-base with main → 0 current-branch commits
  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toBe("No commits on branch `main` ahead of `main`.\n");
});

test("checks out target when all commits have already been merged", async () => {
  const { repoPath, featureCommitSha } = await makeRepoWithDivergedBranch();
  mockMRs = [{ iid: 1, title: "Feature MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: featureCommitSha, short_id: featureCommitSha.slice(0, 8), title: "feature work" }]);

  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    "The 1 commit on branch `feature` has already been merged to `main`.\nSwitching to branch `main`.\n",
  );
  expect((await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(repoPath).text()).trim()).toBe("main");
});

test("exits with error when target branch does not exist", async () => {
  const repoPath = await makeGitRepo();

  const { stderr, exitCode } = await run(["nonexistent-branch"], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("nonexistent-branch");
});

// --- pagination tests ---

test("stops fetching when first page MRs are older than base commit date", async () => {
  mockMRs = [{ iid: 1, title: "Old MR", target_branch: "main", merged_at: OLD, updated_at: OLD }];
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

test("second run stops MR pagination at newest cached updated_at when merge base unchanged", async () => {
  const U2024 = "2024-01-01T00:00:00+00:00";
  const U2023 = "2023-01-01T00:00:00+00:00";
  const U2022 = "2022-01-01T00:00:00+00:00";
  const U2021 = "2021-01-01T00:00:00+00:00";
  const tmpDir = mkdtempSync("/tmp/smart-rebase-cache-since-");
  mockMRs = [
    { iid: 5, title: "MR5", target_branch: "main", merged_at: RECENT, updated_at: U2024 },
    { iid: 4, title: "MR4", target_branch: "main", merged_at: RECENT, updated_at: U2023 },
    { iid: 3, title: "MR3", target_branch: "main", merged_at: RECENT, updated_at: U2022 },
    { iid: 2, title: "MR2", target_branch: "main", merged_at: RECENT, updated_at: U2021 },
    { iid: 1, title: "MR1", target_branch: "main", merged_at: OLD, updated_at: OLD },
  ];
  for (const iid of [1, 2, 3, 4, 5]) mockCommits.set(iid, []);

  await run([], { env: { GITLAB_DATA_DIR: tmpDir, GITLAB_PER_PAGE: "1" } });
  expect(mrPagesFetched).toBe(5);

  // First run rebases the feature branch; reset it so the second run has the same merge base.
  await Bun.$`git checkout feature`.cwd(defaultTestCwd).quiet().nothrow();
  await Bun.$`git reset --hard ${defaultFeatureSha}`.cwd(defaultTestCwd).quiet().nothrow();

  mrPagesFetched = 0;
  await run([], { env: { GITLAB_DATA_DIR: tmpDir, GITLAB_PER_PAGE: "1" } });
  expect(mrPagesFetched).toBe(2);
});

test("refetches from baseDate when merge base moves backwards between runs", async () => {
  const repoPath = await makeGitRepo(); // initial commit at 2020-01-01
  const initialSha = (await Bun.$`git rev-parse HEAD`.cwd(repoPath).text()).trim();
  const D2021 = "2021-01-01T00:00:00+00:00";
  await Bun.$`git commit --allow-empty -m "later main commit"`
    .cwd(repoPath)
    .env({ ...process.env, GIT_AUTHOR_DATE: D2021, GIT_COMMITTER_DATE: D2021 })
    .quiet();
  await Bun.$`git checkout -b feature`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "feature work"`.cwd(repoPath).quiet();

  const tmpDir = mkdtempSync("/tmp/smart-rebase-backwards-");
  mockMRs = [{ iid: 1, title: "MR1", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, []);

  // First run: merge base is 2021 commit; cache stores mergeBaseCommitAt = "2021-01-01".
  await run([], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });

  // Reset feature to branch from the older 2020 initial commit (merge base moves backwards).
  await Bun.$`git reset --hard ${initialSha}`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "older feature"`.cwd(repoPath).quiet();

  // Second run: baseDate "2020-01-01" < cached mergeBaseCommitAt "2021-01-01" → refetch from baseDate.
  const { exitCode } = await run([], { cwd: repoPath, env: { GITLAB_DATA_DIR: tmpDir } });
  expect(exitCode).toBe(0);
});

// --- target branch update tests ---

const REBASE_SUMMARY = "Rebasing `feature` onto `main`. Will rebase 1 commit.";
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
const UPDATE_SUCCESS = "Updating branch `main` from remote `origin`...\n" + "Branch `main` updated.\n";
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
const REBASE_SUCCESS = "Rebasing (1/1)\nSuccessfully rebased and updated `feature`.\n";
// When baseSha equals target tip, git rebase --onto is a no-op.
const REBASE_UPTODATE = "Current branch feature is up to date.\n";

async function makeRepoWithRemoteAhead(): Promise<{ repoPath: string; remoteNewSha: string }> {
  const remotePath = await makeGitRepo();
  const localPath = mkdtempSync("/tmp/smart-rebase-test-");
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

test("exits with error when target branch has no upstream tracking", async () => {
  const repoPath = await makeGitRepo();
  const { stderr, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr.trim()).toBe(
    "Branch `main` isn't tracking an upstream branch. Use something like: `git branch --set-upstream-to=origin/main main`",
  );
});

test("shows no update prompt when target is already up to date with remote", async () => {
  const remotePath = await makeGitRepo();
  const localPath = mkdtempSync("/tmp/smart-rebase-test-");
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
  const localPath = mkdtempSync("/tmp/smart-rebase-test-");
  await Bun.$`git clone ${remotePath} ${localPath}`.quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(localPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(localPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(localPath).quiet();
  await Bun.$`git commit --allow-empty -m "new remote commit"`.cwd(remotePath).quiet();
  const remoteNewSha = (await Bun.$`git rev-parse HEAD`.cwd(remotePath).text()).trim();

  const { stderr, stdout, exitCode } = await run([], { cwd: localPath, inkStdin: KEY_ENTER });
  expect(exitCode).not.toBe(0);
  expect(stderr).toBe(
    UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + "No commits on branch `main` ahead of `main`.\n",
  );
  expect(stdout).toBe("Rebasing onto branch `main`.\n");
  expect((await Bun.$`git rev-parse main`.cwd(localPath).text()).trim()).toBe(remoteNewSha);
  expect((await Bun.$`git rev-parse HEAD`.cwd(localPath).text()).trim()).toBe(remoteNewSha);
  const wtClean = await Bun.$`git diff --quiet && git diff --cached --quiet`.cwd(localPath).quiet().nothrow();
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
    UPDATE_PROMPT_UPDATE_SELECTED + "Cannot update branch `main`: it has diverged from branch `origin/main`.\n",
  );
  expect(stdout).toBe("Rebasing onto branch `main`.\n");
});

// --- stash prompt tests ---

async function makeRepoWithRemoteAheadAndDirty(): Promise<{ repoPath: string; remoteNewSha: string }> {
  const result = await makeRepoWithRemoteAhead();
  writeFileSync(join(result.repoPath, "dirty.txt"), "dirty content");
  await Bun.$`git add dirty.txt`.cwd(result.repoPath).quiet();
  return result;
}

test("shows stash prompt before update prompt when dirty changes exist", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { stderr, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER + KEY_ENTER });
  expect(exitCode).toBe(0);
  // git stash output includes a dynamic SHA, so check the static parts around it
  expect(stderr.startsWith(STASH_PROMPT_STASH_SELECTED + STASH_PROGRESS)).toBe(true);
  expect(stderr.endsWith(UPDATE_PROMPT_UPDATE_SELECTED + UPDATE_SUCCESS + REBASE_PROGRESS + REBASE_SUCCESS)).toBe(true);
});

test("stashes changes when user selects Stash", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_ENTER + KEY_ENTER });
  expect(exitCode).toBe(0);
  const stashList = (await Bun.$`git stash list`.cwd(repoPath).text()).trim();
  expect(stashList).not.toBe("");
});

test("does not stash when user selects Skip on stash prompt", async () => {
  const { repoPath } = await makeRepoWithRemoteAheadAndDirty();
  const { stderr, exitCode } = await run([], { cwd: repoPath, inkStdin: KEY_DOWN + KEY_ENTER + KEY_ENTER });
  // Staged changes were not stashed, so git rebase refuses to run.
  expect(exitCode).not.toBe(0);
  expect(stderr).toBe(
    STASH_PROMPT_SKIP_SELECTED +
      UPDATE_PROMPT_UPDATE_SELECTED +
      UPDATE_SUCCESS +
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
  const mergedShortSha = mergedSha.slice(0, 8);
  await Bun.$`git commit --allow-empty -m "new work"`.cwd(repoPath).quiet();
  const newWorkShortSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "landed on main"`.cwd(repoPath).quiet();
  const mainShortSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();
  await Bun.$`git checkout feature`.cwd(repoPath).quiet();

  mockMRs = [{ iid: 1, title: "Merged MR", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [{ id: mergedSha, short_id: mergedShortSha, title: "merged commit" }]);

  const { stdout, stderr, exitCode } = await run(["--verbose"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    `Current commit: \`${newWorkShortSha}\`\n` +
      "Rebasing onto branch `main`.\n" +
      "!1 Merged MR\n" +
      `  ${mergedShortSha} merged commit\n` +
      "Rebasing `feature` onto `main`. 1 commit has already been merged to `main`. Will rebase 1 commit.\n",
  );
  expect(stderr).toBe(REBASE_PROGRESS + REBASE_SUCCESS);
  // After rebase, "new work" is on top of main's new commit; "merged commit" was dropped.
  const headParent = (await Bun.$`git rev-parse --short HEAD~1`.cwd(repoPath).text()).trim();
  expect(headParent).toBe(mainShortSha);
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

// --- author-date+title commit matching tests ---

/** Commit with explicit author/committer dates so date-based matching is deterministic. */
async function commitWithDate(
  cwd: string,
  message: string,
  date: string,
  opts: { allowEmpty?: boolean; file?: { name: string; content: string } } = {},
): Promise<string> {
  if (opts.file) {
    await Bun.write(join(cwd, opts.file.name), opts.file.content);
    await Bun.$`git add ${opts.file.name}`.cwd(cwd).quiet();
  }
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  if (opts.allowEmpty) {
    await Bun.$`git commit --allow-empty -m ${message}`.cwd(cwd).env(env).quiet();
  } else {
    await Bun.$`git commit -m ${message}`.cwd(cwd).env(env).quiet();
  }
  return (await Bun.$`git rev-parse HEAD`.cwd(cwd).text()).trim();
}

const D_A1 = "2020-06-01T10:00:00+00:00";
const D_A2 = "2020-06-02T10:00:00+00:00";
const D_B1 = "2020-06-03T10:00:00+00:00";
const D_B2 = "2020-06-04T10:00:00+00:00";

test("scenario 1: matches MR commits by author-date and title when SHAs differ", async () => {
  // Mirrors the GitLab "rebase A onto main" flow: A's MR commits have new SHAs
  // (the rebase rewrote them) but the same author dates and titles. Locally, B
  // still has the pre-rebase versions of A's commits. Matching by SHA fails;
  // matching by (author date, title) recognises them as already merged.
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature-b`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: a2", D_A2, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: b1", D_B1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: b2", D_B2, { allowEmpty: true });
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "main moved"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature-b`.cwd(repoPath).quiet();

  // GitLab returns A's rebased commits — different SHAs, same dates/titles.
  mockMRs = [{ iid: 1, title: "MR A", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(1, [
    { id: "a".repeat(40), short_id: "aaaaaaaa", title: "feat: a1", authored_date: D_A1 },
    { id: "b".repeat(40), short_id: "bbbbbbbb", title: "feat: a2", authored_date: D_A2 },
  ]);

  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    "Rebasing `feature-b` onto `main`. 2 commits have already been merged to `main`. Will rebase 2 commits.\n",
  );
  // Only b1 and b2 remain on the rebased branch.
  const log = (await Bun.$`git log --format=%s ${"main"}..HEAD`.cwd(repoPath).text()).trim().split("\n");
  expect(log).toEqual(["feat: b2", "feat: b1"]);
});

test("scenario 2: matches commits against a local target branch (stacked rebase)", async () => {
  // No GitLab merged MR is involved here — the user already locally rebased A
  // onto a newer main, so A's commits have new SHAs. B (still based on old A)
  // is rebased with `smart-rebase a`. Without target-branch matching this
  // would re-apply A's commits and produce duplicates or conflicts.
  const repoPath = await makeGitRepo();

  // Branch A: a1 then a2, with the canonical (date, title) pairs.
  await Bun.$`git checkout -b feature-a`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: a2", D_A2, { allowEmpty: true });

  // Branch B forks off A and adds b1, b2.
  await Bun.$`git checkout -b feature-b`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: b1", D_B1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: b2", D_B2, { allowEmpty: true });

  // Simulate "user rebased A locally": main moves forward, then A's commits
  // are recreated on top with brand-new SHAs but identical dates/titles.
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "main moved"`.cwd(repoPath).quiet();
  await Bun.$`git branch -f feature-a HEAD`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature-a`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: a2", D_A2, { allowEmpty: true });

  // Now rebase B onto the rebased A.
  await Bun.$`git checkout feature-b`.cwd(repoPath).quiet();
  const { stdout, exitCode } = await run(["feature-a"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    "Rebasing `feature-b` onto `feature-a`. 2 commits have already been merged to `feature-a`. Will rebase 2 commits.\n",
  );
  // B is now strictly A + b1 + b2.
  const aTip = (await Bun.$`git rev-parse feature-a`.cwd(repoPath).text()).trim();
  const bParent = (await Bun.$`git rev-parse HEAD~2`.cwd(repoPath).text()).trim();
  expect(bParent).toBe(aTip);
  const log = (await Bun.$`git log --format=%s feature-a..HEAD`.cwd(repoPath).text()).trim().split("\n");
  expect(log).toEqual(["feat: b2", "feat: b1"]);
});

test("scenario 3: combines GitLab merged-MR matching with local target matching", async () => {
  // Setup mirrors a stacked-MR workflow:
  // - C is squash-merged on main (matched via GitLab merged MR).
  // - A is locally rebased onto the new main (matched via local target branch).
  // - B still carries the pre-rebase versions of both C's and A's commits.
  // Both matching kinds must compose so B drops C's *and* A's old commits.
  const D_C1 = "2020-05-01T10:00:00+00:00";
  const D_C2 = "2020-05-02T10:00:00+00:00";

  const repoPath = await makeGitRepo();

  // Original feature branch tree: main → c1, c2 → a1, a2 → b1, b2.
  await Bun.$`git checkout -b feature-c`.cwd(repoPath).quiet();
  const c1OldSha = await commitWithDate(repoPath, "feat: c1", D_C1, { allowEmpty: true });
  const c2OldSha = await commitWithDate(repoPath, "feat: c2", D_C2, { allowEmpty: true });
  await Bun.$`git checkout -b feature-a`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: a2", D_A2, { allowEmpty: true });
  await Bun.$`git checkout -b feature-b`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: b1", D_B1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: b2", D_B2, { allowEmpty: true });

  // C is squash-merged to main (single squash commit).
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "C squashed"`.cwd(repoPath).quiet();

  // A is locally rebased onto new main → new SHAs for a1', a2' but same
  // (date, title). C's commits no longer appear on A's rebased history.
  await Bun.$`git branch -f feature-a HEAD`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature-a`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { allowEmpty: true });
  await commitWithDate(repoPath, "feat: a2", D_A2, { allowEmpty: true });

  // Mock GitLab so the merged MR for C lists its original commits.
  mockMRs = [{ iid: 99, title: "MR C", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(99, [
    { id: c1OldSha, short_id: c1OldSha.slice(0, 8), title: "feat: c1", authored_date: D_C1 },
    { id: c2OldSha, short_id: c2OldSha.slice(0, 8), title: "feat: c2", authored_date: D_C2 },
  ]);

  await Bun.$`git checkout feature-b`.cwd(repoPath).quiet();
  const { stdout, exitCode } = await run(["feature-a"], { cwd: repoPath });
  expect(exitCode).toBe(0);
  // 4 commits dropped: c1 and c2 (via GitLab MR) + a1 and a2 (via target branch).
  expect(stdout).toContain(
    "Rebasing `feature-b` onto `feature-a`. 4 commits have already been merged to `feature-a`. Will rebase 2 commits.\n",
  );
  const aTip = (await Bun.$`git rev-parse feature-a`.cwd(repoPath).text()).trim();
  const bParent = (await Bun.$`git rev-parse HEAD~2`.cwd(repoPath).text()).trim();
  expect(bParent).toBe(aTip);
  const log = (await Bun.$`git log --format=%s feature-a..HEAD`.cwd(repoPath).text()).trim().split("\n");
  expect(log).toEqual(["feat: b2", "feat: b1"]);
});

test("scenario 4: drops squash-merged middle commits matched by author-date+title", async () => {
  // Stack: main → A1, A2 → B1, B2 → C1, C2 (locally on feature-c).
  // Real flow: to squash-merge B without A's changes, the user first locally
  // rebased feature-b onto main (so B has *new* SHAs but the same author
  // dates/titles), pushed, and merged. GitLab's MR commit list for B now
  // contains those rebased SHAs — none of which exist on feature-c.
  // smart-rebase on feature-c must therefore match B by (author date, title)
  // and drop B's commits from the *middle* of the branch.
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature-c`.cwd(repoPath).quiet();
  await commitWithDate(repoPath, "feat: a1", D_A1, { file: { name: "a1.txt", content: "a1\n" } });
  await commitWithDate(repoPath, "feat: a2", D_A2, { file: { name: "a2.txt", content: "a2\n" } });
  await commitWithDate(repoPath, "feat: b1", D_B1, { file: { name: "b1.txt", content: "b1\n" } });
  await commitWithDate(repoPath, "feat: b2", D_B2, { file: { name: "b2.txt", content: "b2\n" } });
  await commitWithDate(repoPath, "feat: c1", "2020-06-05T10:00:00+00:00", {
    file: { name: "c1.txt", content: "c1\n" },
  });
  await commitWithDate(repoPath, "feat: c2", "2020-06-06T10:00:00+00:00", {
    file: { name: "c2.txt", content: "c2\n" },
  });

  // Simulate the squash-merge of the rebased B on main.
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.write(join(repoPath, "b-squash.txt"), "b squashed\n");
  await Bun.$`git add b-squash.txt`.cwd(repoPath).quiet();
  await Bun.$`git commit -m "MR B (squashed)"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature-c`.cwd(repoPath).quiet();

  // GitLab's view of B: rebased SHAs (different from anything on feature-c)
  // but the same author dates and titles as the original B commits.
  mockMRs = [{ iid: 7, title: "MR B", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(7, [
    { id: "b".repeat(40), short_id: "bbbbbbb1", title: "feat: b1", authored_date: D_B1 },
    { id: "1".repeat(40), short_id: "11111111", title: "feat: b2", authored_date: D_B2 },
  ]);

  const { stdout, exitCode } = await run([], { cwd: repoPath });
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    "Rebasing `feature-c` onto `main`. 2 commits have already been merged to `main`. Will rebase 4 commits.\n",
  );
  // After the rebase: main's tip → A1' → A2' → C1' → C2'. B's commits are gone.
  const log = (await Bun.$`git log --format=%s main..HEAD`.cwd(repoPath).text()).trim().split("\n");
  expect(log).toEqual(["feat: c2", "feat: c1", "feat: a2", "feat: a1"]);
  const headParent = (await Bun.$`git rev-parse HEAD~4`.cwd(repoPath).text()).trim();
  const mainTip = (await Bun.$`git rev-parse main`.cwd(repoPath).text()).trim();
  expect(headParent).toBe(mainTip);
});

test("scenario 4: middle-drop interactive rebase reports conflicts like a regular rebase", async () => {
  // Same shape as scenario 4, but the kept commit conflicts with content
  // already on main. We expect git's standard rebase failure: the worktree
  // is left mid-rebase so the user can resolve and `git rebase --continue`,
  // exactly like a non-interactive rebase conflict.
  const repoPath = await makeGitRepo();
  await Bun.$`git checkout -b feature-c`.cwd(repoPath).quiet();
  // A1 modifies a file; main will modify the same file with different content.
  await commitWithDate(repoPath, "feat: a1", D_A1, { file: { name: "shared.txt", content: "from feature\n" } });
  await commitWithDate(repoPath, "feat: b1", D_B1, { file: { name: "b1.txt", content: "b1\n" } });
  await commitWithDate(repoPath, "feat: c1", "2020-06-05T10:00:00+00:00", {
    file: { name: "c1.txt", content: "c1\n" },
  });

  // Main writes a conflicting version of shared.txt.
  await Bun.$`git checkout main`.cwd(repoPath).quiet();
  await Bun.write(join(repoPath, "shared.txt"), "from main\n");
  await Bun.$`git add shared.txt`.cwd(repoPath).quiet();
  await Bun.$`git commit -m "main writes shared"`.cwd(repoPath).quiet();
  await Bun.$`git checkout feature-c`.cwd(repoPath).quiet();

  // GitLab MR for B uses a rebased SHA — matching falls through to
  // (author date, title), exercising the same code path as the happy case.
  mockMRs = [{ iid: 7, title: "MR B", target_branch: "main", merged_at: RECENT, updated_at: RECENT }];
  mockCommits.set(7, [{ id: "b".repeat(40), short_id: "bbbbbbb1", title: "feat: b1", authored_date: D_B1 }]);

  const { exitCode, stderr } = await run([], { cwd: repoPath });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("CONFLICT");
  // Clean up mid-rebase state so the temp dir is usable.
  await Bun.$`git rebase --abort`.cwd(repoPath).quiet().nothrow();
});
