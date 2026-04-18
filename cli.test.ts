import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createCli, type Argv } from "./cli";

async function parse(args: string[]): Promise<Argv> {
  return createCli(args).parseAsync();
}

test("verbose defaults to false", async () => {
  const argv = await parse([]);
  expect(argv.verbose).toBe(false);
});

test("--verbose flag is recognised", async () => {
  const argv = await parse(["--verbose"]);
  expect(argv.verbose).toBe(true);
});

test("-v alias works", async () => {
  const argv = await parse(["-v"]);
  expect(argv.verbose).toBe(true);
});

test("unknown flag throws in strict mode", async () => {
  await expect(parse(["--unknown"])).rejects.toThrow();
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

  const output = await Bun.$`bun run ${join(import.meta.dir, "index.ts")}`.cwd(repoPath).text();

  expect(output.trim()).toBe(expectedSha);
});
