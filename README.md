# smart-rebase

A smarter `git rebase` for GitLab\* projects. It rebases your branch onto the latest target branch and **automatically drops commits that have already been merged** via merge requests — even when GitLab rewrote them during a rebase-and-merge, so their SHAs no longer match anything in your history.

If you work with stacked merge requests, or your team merges MRs with "rebase before merge", a plain `git rebase main` regularly greets you with conflicts on commits that are already on `main`. `smart-rebase` asks the GitLab API what actually got merged and skips those commits for you.

\* GitHub support coming when someone asks for it.

## Install

Install [Bun](https://bun.com) if you don't have it yet:

```sh
curl -fsSL https://bun.sh/install | bash
```

Install the command:

```sh
bun install -g github:xixixao/smart-rebase
```

This makes the `smart-rebase` command available globally.

## Usage

From a feature branch inside a GitLab-hosted repository:

```bash
smart-rebase [target] [options]
```

- `target` — the branch to rebase onto (defaults to `main`)
- `-v, --verbose` — show which merged MRs and commits were considered
- `-h, --help`, `-V, --version`

On first run it will ask for a GitLab personal access token (with `api` scope) and offer to open the token-creation page in your browser. The token is saved locally for future runs.

## What it does

A single run walks through these steps:

1. **Checks for uncommitted changes** and offers to stash them.
2. **Checks the target branch against its remote** and offers to fast-forward it if it is behind.
3. **Fetches merged MRs from GitLab** since the point where your branch diverged from the target (results are cached per project, so repeat runs are fast).
4. **Rebases your branch with already-merged commits dropped.** Commits are matched by SHA, and also by author date + title, so a commit that GitLab rebased (giving it a new SHA) is still recognized as merged. Exactly one `git rebase` is invoked.

If every commit on your branch has already been merged, it skips the rebase and simply switches you to the target branch.

## Interesting scenarios

**Your MR was rebase-merged.** GitLab's "rebase before merge" gives your commits new SHAs on `main`. Plain `git rebase main` then tries to replay your originals and conflicts with themselves. `smart-rebase` recognizes the rewritten copies and drops your local originals.

**Stacked merge requests.** You have `feature-b` stacked on `feature-a`. When you run `smart-rebase feature-a`, commits that belong to `feature-a` (including copies rewritten by an earlier rebase of `feature-a`) are detected and skipped, and MRs merged to `main` are still taken into account since `main` is an ancestor of `feature-a`.

**Partially merged branches.** Only some of your commits made it into merged MRs — even non-contiguously, with merged and unmerged commits interleaved. `smart-rebase` drops exactly the merged ones in a single rebase and keeps the rest.

## Configuration

Everything is configured through environment variables; none are required when working against `gitlab.com` with an `origin` remote:

| Variable          | Purpose                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `GITLAB_TOKEN`    | Personal access token (`api` scope). Otherwise read from `~/.netrc` or saved credentials. |
| `GITLAB_URL`      | Base URL for self-hosted GitLab (default `https://gitlab.com`).                           |
| `GITLAB_PROJECT`  | Project path or ID, if it can't be derived from the git remote URL.                       |
| `GITLAB_DATA_DIR` | Where credentials and the MR cache are stored (defaults to the platform data dir).        |

## Update

To update to the latest version, run:

```sh
bun remove -g smart-rebase
bun install -g github:xixixao/smart-rebase
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests, and coverage requirements.
