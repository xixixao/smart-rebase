import { test, expect } from "bun:test";
import { getAuth, GITLAB_TOKEN_URL } from "./auth";

test("returns env vars when both are set", async () => {
  const auth = await getAuth({
    env: { GITLAB_USERNAME: "alice", GITLAB_TOKEN: "secret" },
  });
  expect(auth.username).toBe("alice");
  expect(auth.token).toBe("secret");
});

test("does not prompt when both env vars are set", async () => {
  let prompted = false;
  await getAuth({
    env: { GITLAB_USERNAME: "alice", GITLAB_TOKEN: "secret" },
    prompt: async () => {
      prompted = true;
      return "";
    },
    write: () => {},
    openBrowser: async () => {},
  });
  expect(prompted).toBe(false);
});

test("prompts for username when GITLAB_USERNAME is not set", async () => {
  const written: string[] = [];
  const auth = await getAuth({
    env: { GITLAB_TOKEN: "secret" },
    write: (msg) => written.push(msg),
    prompt: async (q) => (q.toLowerCase().includes("username") ? "alice" : ""),
    openBrowser: async () => {},
  });
  expect(auth.username).toBe("alice");
  expect(written.join("")).toContain("GITLAB_USERNAME");
});

test("prompts for token when GITLAB_TOKEN is not set", async () => {
  const written: string[] = [];
  const auth = await getAuth({
    env: { GITLAB_USERNAME: "alice" },
    write: (msg) => written.push(msg),
    prompt: async () => "mytoken",
    openBrowser: async () => {},
  });
  expect(auth.token).toBe("mytoken");
  const output = written.join("");
  expect(output).toContain("GITLAB_TOKEN");
  expect(output).toContain(GITLAB_TOKEN_URL);
});

test("token prompt shows URL with api scope", async () => {
  const written: string[] = [];
  await getAuth({
    env: { GITLAB_USERNAME: "alice" },
    write: (msg) => written.push(msg),
    prompt: async () => "mytoken",
    openBrowser: async () => {},
  });
  expect(written.join("")).toContain("scopes=api");
});

test("opens browser when user presses Enter on token prompt", async () => {
  const openedUrls: string[] = [];
  let promptCount = 0;

  const auth = await getAuth({
    env: { GITLAB_USERNAME: "alice" },
    write: () => {},
    prompt: async () => {
      promptCount++;
      return promptCount === 1 ? "" : "finaltoken";
    },
    openBrowser: async (url) => {
      openedUrls.push(url);
    },
  });

  expect(auth.token).toBe("finaltoken");
  expect(openedUrls).toEqual([GITLAB_TOKEN_URL]);
});

test("does not open browser when token pasted directly", async () => {
  const openedUrls: string[] = [];

  const auth = await getAuth({
    env: { GITLAB_USERNAME: "alice" },
    write: () => {},
    prompt: async () => "pastedtoken",
    openBrowser: async (url) => {
      openedUrls.push(url);
    },
  });

  expect(auth.token).toBe("pastedtoken");
  expect(openedUrls).toHaveLength(0);
});

test("trims whitespace from username and token", async () => {
  const auth = await getAuth({
    env: {},
    write: () => {},
    prompt: async (q) =>
      q.toLowerCase().includes("username") ? "  alice  " : "  mytoken  ",
    openBrowser: async () => {},
  });
  expect(auth.username).toBe("alice");
  expect(auth.token).toBe("mytoken");
});

test("prompts for both when neither env var is set", async () => {
  let callCount = 0;
  const prompts: string[] = [];

  const auth = await getAuth({
    env: {},
    write: () => {},
    prompt: async (q) => {
      prompts.push(q);
      callCount++;
      return callCount === 1 ? "myuser" : "mytoken";
    },
    openBrowser: async () => {},
  });

  expect(auth.username).toBe("myuser");
  expect(auth.token).toBe("mytoken");
  expect(prompts.some((q) => q.toLowerCase().includes("username"))).toBe(true);
});
