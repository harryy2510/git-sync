# Contributing to repo-sync

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Docker](https://www.docker.com/) (for building/testing the container)
- Git

### Getting Started

```bash
# Clone the repo
git clone https://github.com/harryy2510/git-sync.git
cd repo-sync

# Install dependencies
bun install

# Run in development mode (with hot reload)
bun run dev

# Type check
bun run typecheck

# Build
bun run build
```

### Testing with Docker

```bash
# Build the image locally
docker build -t repo-sync:dev .

# Run with a simple config
docker run --rm \
  -e REPOS="your-org/your-repo" \
  -e REPOS_BASE_URL="https://github.com/" \
  -v /tmp/workspace:/workspace \
  -p 8080:8080 \
  repo-sync:dev
```

## Making Changes

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b my-feature`
3. **Make your changes** and ensure they pass type checking: `bun run typecheck`
4. **Test locally** with Docker if your changes affect the runtime
5. **Commit** with a clear, concise message in imperative mood
6. **Open a Pull Request** against `main`

## Code Style

- TypeScript strict mode
- ES modules
- Keep it simple — this is a single-file application by design
- No unnecessary abstractions or dependencies

## Reporting Issues

- Use [GitHub Issues](https://github.com/harryy2510/git-sync/issues)
- Include your Docker/OS version, configuration method, and relevant logs
- For security vulnerabilities, please email the maintainers directly instead of opening a public issue

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
