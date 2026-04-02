<div align="center">

# git-sync

**Keep multiple Git repositories in sync. Automatically.**

Full clones, all branches, periodic pull, env file injection, post-sync hooks, health API.

[![CI](https://img.shields.io/github/actions/workflow/status/harryy2510/git-sync/build.yml?branch=main&label=CI&logo=github)](https://github.com/harryy2510/git-sync/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-git--sync-blue?logo=docker&logoColor=white)](https://github.com/harryy2510/git-sync/pkgs/container/git-sync)

</div>

---

## Why?

When you work with AI coding agents, cloud workspaces, or self-hosted dev environments, you need your repositories cloned, up-to-date, and ready to go. **git-sync** runs as a lightweight sidecar container that keeps your repos synced with zero manual intervention.

- **Full clones** with all branches (supports git worktrees)
- **Periodic sync** on a configurable interval
- **Env file injection** to populate `.env` files after sync
- **Post-sync hooks** to run arbitrary commands when code changes
- **Health API** for monitoring and on-demand sync triggers
- **Three config modes** — from simple env vars to full YAML

## Quick Start

### Option 1: Comma-separated repos (simplest)

```bash
docker run -d \
  -v ~/workspace:/workspace \
  -v ~/.ssh:/root/.ssh:ro \
  -e REPOS="your-org/frontend,your-org/backend" \
  -e SSH_KEY_FILE=/root/.ssh/id_ed25519 \
  -p 8080:8080 \
  ghcr.io/harryy2510/git-sync:latest
```

### Option 2: YAML config file

```yaml
# repos.yaml
workspace: /workspace
interval: 120
repos:
  - url: git@github.com:your-org/frontend.git
    path: your-org/frontend
    ref: main
    env_files:
      "frontend.env": ".env.development"
    post_sync:
      - "cp .env.development .dev.vars"
```

```bash
docker run -d \
  -v ~/workspace:/workspace \
  -v ~/.ssh:/root/.ssh:ro \
  -v ./repos.yaml:/config/repos.yaml:ro \
  -p 8080:8080 \
  ghcr.io/harryy2510/git-sync:latest
```

### Option 3: Inline YAML via env var

```bash
docker run -d \
  -v ~/workspace:/workspace \
  -v ~/.ssh:/root/.ssh:ro \
  -e REPOS_CONFIG="
workspace: /workspace
interval: 120
repos:
  - url: git@github.com:your-org/frontend.git
    path: your-org/frontend
" \
  ghcr.io/harryy2510/git-sync:latest
```

## Configuration

### Config priority

1. **Config file** at `/config/repos.yaml` (or `CONFIG_FILE` env var)
2. **Inline YAML** via `REPOS_CONFIG` env var
3. **Simple list** via `REPOS` env var with `REPOS_BASE_URL`

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CONFIG_FILE` | `/config/repos.yaml` | Path to YAML config |
| `REPOS_CONFIG` | &mdash; | Inline YAML config |
| `REPOS` | &mdash; | Comma-separated `org/repo` list |
| `REPOS_BASE_URL` | `git@github.com:` | Prefix for `REPOS` entries |
| `DEFAULT_REF` | `main` | Default branch for `REPOS` mode |
| `WORKSPACE` | `/workspace` | Base directory for cloned repos |
| `SYNC_INTERVAL` | `120` | Seconds between sync cycles |
| `SSH_KEY_FILE` | &mdash; | Path to SSH private key |
| `SSH_STRICT_HOST_CHECKING` | `false` | Verify SSH host keys |
| `GIT_USER_NAME` | &mdash; | Global `git user.name` |
| `GIT_USER_EMAIL` | &mdash; | Global `git user.email` |
| `HEALTH_PORT` | `8080` | Health/status API port (`0` to disable) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Full YAML reference

```yaml
workspace: /workspace
interval: 120
ssh_key: /root/.ssh/id_ed25519
ssh_strict_host_checking: false
git_user_name: "Your Name"
git_user_email: "you@example.com"
health_port: 8080
log_level: info

repos:
  - url: git@github.com:org/repo.git    # required
    path: org/repo                       # required (relative to workspace)
    ref: main                            # branch or tag (default: HEAD)
    depth: 0                             # 0 = full history
    enabled: true                        # set false to skip
    env_files:                           # copy files after sync
      "source.env": ".env"               #   /env-files/source.env -> repo/.env
    post_sync:                           # commands to run after sync
      - "cp .env .dev.vars"
```

## Health API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | `200` if all repos ok, `503` if any failed |
| `/status` | `GET` | Detailed JSON with per-repo status, hashes, branches |
| `/config` | `GET` | Current config (URLs redacted) |
| `/sync` | `POST` | Trigger an immediate sync cycle |

<details>
<summary>Example <code>/status</code> response</summary>

```json
{
  "uptime": "2026-01-15T10:00:00.000Z",
  "interval": 120,
  "repos": [
    {
      "repo": "git@github.com:org/repo.git",
      "path": "/workspace/org/repo",
      "last_sync": "2026-01-15T10:02:00.000Z",
      "last_hash": "a1b2c3d4e5f6",
      "status": "ok",
      "branches": ["main", "develop", "origin/main", "origin/develop"]
    }
  ]
}
```

</details>

## Env File Injection

Mount a directory with your environment files at `/env-files`, then reference them in your repo config:

```yaml
repos:
  - url: git@github.com:org/app.git
    path: org/app
    env_files:
      "app.env.dev": ".env.development"
      "app.env.prod": ".env.production"
    post_sync:
      - "cp .env.development .dev.vars"
```

Files are copied after every successful sync where the commit hash changed.

## Docker Compose

```yaml
services:
  git-sync:
    image: ghcr.io/harryy2510/git-sync:latest
    container_name: git-sync
    restart: unless-stopped
    volumes:
      - ~/workspace:/workspace
      - ~/.ssh:/root/.ssh:ro
      - ./repos.yaml:/config/repos.yaml:ro
      # - ./env-files:/env-files:ro
    environment:
      SSH_KEY_FILE: /root/.ssh/id_ed25519
      GIT_USER_NAME: "Your Name"
      GIT_USER_EMAIL: "you@example.com"
```

> See [`examples/`](examples/) for more Docker Compose configurations including inline YAML and env-only setups.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  git-sync container                            │
│                                                 │
│  ┌───────────┐   ┌──────────┐   ┌───────────┐  │
│  │  Config    │──>│  Sync    │──>│  Health   │  │
│  │  Loader    │   │  Loop    │   │  Server   │  │
│  └───────────┘   └──────────┘   └───────────┘  │
│       │               │                         │
│       │          ┌────┴────┐                    │
│       │          │ For each│                    │
│       │          │  repo:  │                    │
│       │          │         │                    │
│       │          │ clone   │                    │
│       │          │ fetch   │                    │
│       │          │ pull    │                    │
│       │          │ env cp  │                    │
│       │          │ hooks   │                    │
│       │          └─────────┘                    │
│       │                                         │
│  YAML file / REPOS_CONFIG / REPOS env var       │
└─────────────────────────────────────────────────┘
         │                    │
    /workspace           /env-files
    (volume)             (volume)
```

- **Full `git clone`** (not shallow by default) — supports worktrees and branch switching
- **`git fetch --all`** on each cycle — all remote branches stay available
- **Post-sync hooks only fire** when the commit hash actually changes
- **Single container**, multiple repos — no orchestration needed
- **Multi-arch image** — `linux/amd64` + `linux/arm64`

## Development

```bash
# Install dependencies
bun install

# Run with hot reload
bun run dev

# Type check
bun run typecheck

# Build for production
bun run build
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
