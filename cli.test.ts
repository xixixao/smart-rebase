import { test, expect } from "bun:test";
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
