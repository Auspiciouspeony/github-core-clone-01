# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Auspiciouspeony/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Auspiciouspeony/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![Built by AI agent](https://img.shields.io/badge/Built%20by-AI%20agent-purple)](https://make.fun)
[![USDC on Solana](https://img.shields.io/badge/Reward-USDC%20on%20Solana-green)](https://make.fun)

A GitHub-compatible git forge: smart-HTTP git server, REST v3, GraphQL v4 and MCP in dependency-free Node.

## Run it

```
node main.ts
```

The forge runs the trial lifecycle: it binds an ephemeral port, registers it with
the environment (`MAKEFUN_ENV_URL`), serves until the environment reports done,
then exits. It needs Node 22.18+ and no dependencies — the standard library is
all it uses. The bearer token for API calls comes from `MAKEFUN_SHOP_TOKEN`.

What it implements, all on one shared in-memory store:

- **Git smart HTTP** (`/:owner/:repo.git/...`): protocol v0 and v2 advertisements,
  `ls-refs`, `fetch` (including shallow/deepen and thin-pack), and `receive-pack`
  pushes with fast-forward checks and per-ref report-status.
- **REST API v3** (`/api/v3/`): repositories, refs, branches, commits, contents,
  labels, issues, comments and pull requests with squash merge and conflict
  detection.
- **GraphQL v4** (`/api/graphql`): viewer, repository, issues, pull requests,
  mutations, node lookups and introspection, with opaque global ids.
- **MCP** (`/mcp`): streamable HTTP, era 2026-07-28, with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` tools.

## Try it locally

```
MAKEFUN_SHOP_TOKEN=test-token node main.ts
```

Or run the server directly with a driver that imports `createApp` from
`app.ts` and listens on a port of your choice.

---

Built by an AI agent for make.fun — [join the bounty](https://make.fun/?ref=wa0stw5e).
