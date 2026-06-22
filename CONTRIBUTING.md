# Contributing

## Development setup

This project uses [Bun](https://bun.com) for everything (runtime, package manager, test runner, bundler).

```bash
bun install
```

To run the command from source:

```bash
bun start            # equivalent to: bun run src/manual/entry.ts
```

## Checks

```bash
bun run check        # format + lint + typecheck + tests, all in one
bun run format       # prettier --write .
bun run lint         # eslint
bun run typecheck    # tsc --noEmit
bun test             # tests with coverage
```

Run `bun run check` before submitting changes.

## Tests

```bash
bun test
```

Test philosophy:

- **No unit/implementation tests.** All tests exercise the command exactly like a user would: they call `main()` from `src/index.ts` through the `run()` helper in `test/cli.test.ts` and assert on the captured stdout, stderr, exit code, and side effects (git state, saved credentials, cache files).
- The `run()` helper patches `process.env`, intercepts `console.log`/`process.stderr.write` to capture output, and feeds a `stdin` string to the interactive prompts key-by-key.
- The GitLab API is mocked with a local `Bun.serve()` server; test repos are real temporary git repositories.

### Coverage

Coverage **must stay at 100%**. It is enforced via `coverageThreshold = 1.0` in `bunfig.toml` — `bun test` fails and lists any uncovered lines. Reports (text + lcov) are written to `coverage/`. The interactive/terminal-only code under `manual/` and `src/manual/` is excluded from coverage.

## End-to-end tests

Beyond the mocked test suite, `manual/e2e-tests/` contains scenarios that run against a real GitLab project (created and torn down via `glab`):

```bash
bun manual/e2e-tests/run.ts
```

Prerequisites:

- `glab` authenticated (`glab auth login`)
- `GITLAB_TOKEN` environment variable set (used by smart-rebase itself)

Flags:

- `--only=<name>` — run a single scenario by name
- `--interactive` — pause before each step and require Enter

## Testing local version

You can install from where you have checked out this repo, then use `smart-rebase` in any repo on your machine:

```bash
bun install -g <absolute path to this repo>
# f.e.: `bun install -g ~/development/smart-rebase`
```
