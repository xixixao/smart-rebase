import { test, expect } from "bun:test";
import { createCli, type Options } from "./cli";

test("name is gitlab-rebase", () => {
  expect(createCli().name()).toBe("gitlab-rebase");
});

test("version is 0.1.0", () => {
  expect(createCli().version()).toBe("0.1.0");
});

test("description is set", () => {
  expect(createCli().description().length).toBeGreaterThan(0);
});

test("verbose defaults to false", () => {
  const program = createCli();
  program.parse([], { from: "user" });
  expect(program.opts<Options>().verbose).toBe(false);
});

test("--verbose flag is recognised", () => {
  const program = createCli();
  program.parse(["--verbose"], { from: "user" });
  expect(program.opts<Options>().verbose).toBe(true);
});
