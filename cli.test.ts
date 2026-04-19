import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

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

test("prints HEAD short sha", async () => {
  const repoPath = mkdtempSync("/tmp/gitlab-rebase-test-");
  const GIT_DATE = "2020-01-01T00:00:00+00:00";

  await Bun.$`git init`.cwd(repoPath).quiet();
  await Bun.$`git config user.email "test@example.com"`.cwd(repoPath).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(repoPath).quiet();
  await Bun.$`git config commit.gpgsign false`.cwd(repoPath).quiet();
  await Bun.$`git commit --allow-empty -m "Initial commit"`
    .cwd(repoPath)
    .env({ ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE })
    .quiet();

  const expectedSha = (await Bun.$`git rev-parse --short HEAD`.cwd(repoPath).text()).trim();

  const output = await Bun.$`bun run ${join(import.meta.dir, "index.ts")}`
    .cwd(repoPath)
    .env({
      ...process.env,
      GIT_AUTHOR_DATE: GIT_DATE,
      GIT_COMMITTER_DATE: GIT_DATE,
      GITLAB_USERNAME: "testuser",
      GITLAB_TOKEN: "testtoken",
    })
    .text();

  expect(output.trim()).toBe(expectedSha);
});

test("prompts for GITLAB_USERNAME and GITLAB_TOKEN when not set", async () => {
  const { stderr, exitCode } = await run([], {
    env: { GITLAB_USERNAME: undefined, GITLAB_TOKEN: undefined },
    stdin: "myuser\nmytoken\n",
  });
  expect(exitCode).toBe(0);
  expect(stderr).toContain("GITLAB_USERNAME");
  expect(stderr).toContain("GITLAB_TOKEN");
});
