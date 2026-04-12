import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { exec, type ExecOptions } from 'child_process'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { parse as parseYaml } from 'yaml'
import { createServer } from 'http'

// ─── Types ───────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type RepoConfig = {
  url: string
  path?: string
  ref?: string
  depth?: number
  env_files?: Record<string, string>
  post_sync?: string[]
  enabled?: boolean
}

type Config = {
  workspace: string
  interval: number
  ssh_key?: string
  ssh_strict_host_checking?: boolean
  git_user_name?: string
  git_user_email?: string
  health_port?: number
  log_level?: LogLevel
  concurrency?: number
  repos: RepoConfig[]
}

type SyncStatus = {
  repo: string
  path: string
  last_sync: string | null
  last_hash: string | null
  status: 'ok' | 'error' | 'pending'
  error?: string
  branches?: string[]
}

// ─── Globals ─────────────────────────────────────────────────────────────────

let config: Config
const syncStatuses = new Map<string, SyncStatus>()
const startTime = new Date().toISOString()
let syncInFlight = false

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LOG_ICONS: Record<LogLevel, string> = { debug: '\u{1f50d}', info: '\u2705', warn: '\u26a0\ufe0f', error: '\u274c' }

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < LOG_LEVELS[config?.log_level ?? 'info']) return
  const ts = new Date().toISOString()
  const extraStr = extra ? ' ' + JSON.stringify(extra) : ''
  console.log(`${ts} ${LOG_ICONS[level]} [${level.toUpperCase()}] ${msg}${extraStr}`)
}

// ─── Config Loading ──────────────────────────────────────────────────────────

function loadConfig(): Config {
  const configPath = process.env.CONFIG_FILE ?? '/config/repos.yaml'

  if (existsSync(configPath)) {
    log('info', `Loading config from ${configPath}`)
    const raw = readFileSync(configPath, 'utf-8')
    return applyEnvOverrides(parseYaml(raw) as Config)
  }

  if (process.env.REPOS_CONFIG) {
    log('info', 'Loading config from REPOS_CONFIG env var')
    return applyEnvOverrides(parseYaml(process.env.REPOS_CONFIG) as Config)
  }

  if (process.env.REPOS) {
    log('info', 'Loading config from REPOS env var')
    return buildConfigFromEnv()
  }

  throw new Error('No config found. Set CONFIG_FILE, REPOS_CONFIG, or REPOS env var.')
}

function applyEnvOverrides(c: Config): Config {
  return {
    ...c,
    workspace: process.env.WORKSPACE ?? c.workspace ?? '/workspace',
    interval: parseInt(process.env.SYNC_INTERVAL ?? String(c.interval ?? 120)),
    ssh_key: process.env.SSH_KEY_FILE ?? c.ssh_key,
    ssh_strict_host_checking: process.env.SSH_STRICT_HOST_CHECKING === 'true' || c.ssh_strict_host_checking,
    git_user_name: process.env.GIT_USER_NAME ?? c.git_user_name,
    git_user_email: process.env.GIT_USER_EMAIL ?? c.git_user_email,
    health_port: parseInt(process.env.HEALTH_PORT ?? String(c.health_port ?? 0)),
    log_level: (process.env.LOG_LEVEL as Config['log_level']) ?? c.log_level ?? 'info',
    concurrency: parseInt(process.env.SYNC_CONCURRENCY ?? String(c.concurrency ?? 2)),
    repos: c.repos ?? [],
  }
}

function buildConfigFromEnv(): Config {
  const baseUrl = process.env.REPOS_BASE_URL ?? 'git@github.com:'
  const workspace = process.env.WORKSPACE ?? '/workspace'
  const repos: RepoConfig[] = (process.env.REPOS ?? '').split(',').filter(Boolean).map((entry) => {
    const trimmed = entry.trim()
    const parts = trimmed.split('/')
    const org = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    const repo = parts[parts.length - 1]
    const orgDir = org.toLowerCase().replace(/[^a-z0-9-]/g, '-')

    return {
      url: `${baseUrl}${trimmed}.git`,
      path: orgDir ? `${orgDir}/${repo}` : repo,
      ref: process.env.DEFAULT_REF ?? 'main',
      enabled: true,
    }
  })

  return applyEnvOverrides({ workspace, interval: 120, repos })
}

function derivePathFromUrl(url: string): string {
  // git@github.com:org/repo.git -> org/repo
  // https://github.com/org/repo.git -> org/repo
  // https://github.com/org/repo -> org/repo
  const cleaned = url.replace(/\.git$/, '')
  const sshMatch = cleaned.match(/:([^/].*?)$/)
  if (sshMatch) return sshMatch[1]
  try {
    const u = new URL(cleaned)
    return u.pathname.replace(/^\//, '')
  } catch {
    return cleaned
  }
}

function resolveRepoPath(repo: RepoConfig): string {
  return repo.path ?? derivePathFromUrl(repo.url)
}

// ─── Git Operations ──────────────────────────────────────────────────────────

function buildSshCommand(): string {
  const parts = ['ssh']
  if (!config.ssh_strict_host_checking) {
    parts.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null')
  }
  if (config.ssh_key) {
    parts.push('-i', config.ssh_key)
  }
  return parts.join(' ')
}

function run(cmd: string, cwd?: string): Promise<string> {
  log('debug', `$ ${cmd}`, { cwd })
  const opts: ExecOptions = {
    cwd,
    env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand() },
    timeout: 300_000,
    maxBuffer: 50 * 1024 * 1024,
  }
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${cmd}\n${stderr}`))
      } else {
        resolve((stdout ?? '').toString().trim())
      }
    })
  })
}

async function cloneRepo(repo: RepoConfig, fullPath: string): Promise<void> {
  const parentDir = dirname(fullPath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  const depthArg = repo.depth ? `--depth ${repo.depth}` : ''
  const refArg = repo.ref && repo.ref !== 'HEAD' ? `--branch ${repo.ref}` : ''

  log('info', `Cloning ${repo.url} -> ${fullPath}`)
  await run(`git clone ${depthArg} ${refArg} ${repo.url} ${fullPath}`)

  if (!repo.depth) {
    await run('git fetch --all -q', fullPath)
  }
}

async function syncRepo(repo: RepoConfig, fullPath: string): Promise<{ hash: string; branches: string[] }> {
  log('debug', `Fetching ${repo.url}`)
  await run('git fetch --all --prune -q', fullPath)

  try {
    const branch = await run('git symbolic-ref --short HEAD', fullPath)
    if (branch) {
      const remote = await run(`git config branch.${branch}.remote`, fullPath).catch(() => 'origin')
      await run(`git reset --hard ${remote}/${branch}`, fullPath)
    }
  } catch {
    // Detached HEAD — skip reset
  }

  const hash = await run('git rev-parse HEAD', fullPath)
  const branchesRaw = await run("git branch -a --format='%(refname:short)'", fullPath)
  const branches = branchesRaw.split('\n').filter(Boolean)

  return { hash, branches }
}

function copyEnvFiles(repo: RepoConfig, fullPath: string): void {
  if (!repo.env_files) return

  for (const [src, dest] of Object.entries(repo.env_files)) {
    const srcPath = src.startsWith('/') ? src : join('/env-files', src)
    const destPath = join(fullPath, dest)

    if (existsSync(srcPath)) {
      const destDir = dirname(destPath)
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

      const content = readFileSync(srcPath, 'utf-8')
      writeFileSync(destPath, content)
      log('debug', `Copied env: ${srcPath} -> ${destPath}`)
    } else {
      log('warn', `Env file not found: ${srcPath}`)
    }
  }
}

async function runPostSync(repo: RepoConfig, fullPath: string): Promise<void> {
  if (!repo.post_sync?.length) return

  for (const cmd of repo.post_sync) {
    try {
      log('debug', `Running post-sync: ${cmd}`)
      await run(cmd, fullPath)
    } catch (err) {
      log('warn', `Post-sync command failed: ${cmd}`, { error: (err as Error).message })
    }
  }
}

// ─── Sync Loop ───────────────────────────────────────────────────────────────

function setupGit(): void {
  // Write a gitconfig to a writable location so we don't depend on $HOME/.gitconfig
  // being writable (common issue when running as non-root in containers)
  const gitconfigPath = join(tmpdir(), '.gitconfig')
  const lines: string[] = []

  if (config.git_user_name || config.git_user_email) {
    lines.push('[user]')
    if (config.git_user_name) lines.push(`\tname = ${config.git_user_name}`)
    if (config.git_user_email) lines.push(`\temail = ${config.git_user_email}`)
  }

  lines.push('[safe]')
  lines.push('\tdirectory = *')

  writeFileSync(gitconfigPath, lines.join('\n') + '\n')
  process.env.GIT_CONFIG_GLOBAL = gitconfigPath
  log('debug', `Wrote git config to ${gitconfigPath}`)
}

async function syncOne(repo: RepoConfig): Promise<void> {
  const repoPath = resolveRepoPath(repo)
  const fullPath = join(config.workspace, repoPath)
  const status: SyncStatus = syncStatuses.get(repo.url) ?? {
    repo: repo.url,
    path: fullPath,
    last_sync: null,
    last_hash: null,
    status: 'pending',
  }

  try {
    if (!existsSync(join(fullPath, '.git'))) {
      await cloneRepo(repo, fullPath)
    }

    const { hash, branches } = await syncRepo(repo, fullPath)

    if (hash !== status.last_hash) {
      log('info', `Updated ${repoPath}`, { hash: hash.slice(0, 8), branches: branches.length })
      copyEnvFiles(repo, fullPath)
      await runPostSync(repo, fullPath)
    } else {
      log('debug', `No changes: ${repoPath}`)
    }

    status.last_sync = new Date().toISOString()
    status.last_hash = hash
    status.status = 'ok'
    status.branches = branches
    delete status.error
  } catch (err) {
    log('error', `Failed to sync ${repo.url}`, { error: (err as Error).message })
    status.status = 'error'
    status.error = (err as Error).message
  }

  syncStatuses.set(repo.url, status)
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, limit)
  let i = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx])
    }
  })
  await Promise.all(runners)
}

async function syncAll(): Promise<void> {
  if (syncInFlight) {
    log('warn', 'Previous sync still running, skipping this tick')
    return
  }
  syncInFlight = true
  try {
    const enabledRepos = config.repos.filter((r) => r.enabled !== false)
    const limit = config.concurrency ?? 2
    log('info', `Syncing ${enabledRepos.length} repos (concurrency=${limit})...`)
    await runWithConcurrency(enabledRepos, limit, (repo) => syncOne(repo))
    const statuses = Array.from(syncStatuses.values())
    const ok = statuses.filter((s) => s.status === 'ok').length
    const errored = statuses.filter((s) => s.status === 'error').length
    log('info', `Sync complete`, { ok, errored })
  } finally {
    syncInFlight = false
  }
}

// ─── Health Server ───────────────────────────────────────────────────────────

function startHealthServer(port: number): void {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.url === '/health') {
      const statuses = Array.from(syncStatuses.values())
      const allOk = statuses.length > 0 && statuses.every((s) => s.status === 'ok')
      res.statusCode = allOk ? 200 : 503
      res.end(JSON.stringify({ status: allOk ? 'ok' : 'degraded', uptime: startTime }))
      return
    }

    if (req.url === '/status') {
      res.statusCode = 200
      res.end(JSON.stringify({
        uptime: startTime,
        interval: config.interval,
        repos: Array.from(syncStatuses.values()),
      }, null, 2))
      return
    }

    if (req.url === '/config') {
      res.statusCode = 200
      const safeConfig = {
        ...config,
        repos: config.repos.map((r) => ({ ...r, url: r.url.replace(/\/\/.*@/, '//***@') })),
      }
      res.end(JSON.stringify(safeConfig, null, 2))
      return
    }

    if (req.url === '/sync' && req.method === 'POST') {
      res.statusCode = 202
      res.end(JSON.stringify({ message: 'sync triggered' }))
      syncAll().catch((err) => log('error', 'Manual sync failed', { error: (err as Error).message }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found', endpoints: ['/health', '/status', '/config', 'POST /sync'] }))
  })

  server.listen(port, '0.0.0.0', () => {
    log('info', `Health server listening on :${port}`)
  })
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  config = loadConfig()

  log('info', 'git-sync starting', {
    workspace: config.workspace,
    interval: config.interval,
    repos: config.repos.length,
  })

  setupGit()

  if (config.health_port) {
    startHealthServer(config.health_port)
  }

  await syncAll()

  setInterval(() => {
    syncAll().catch((err) => log('error', 'Sync loop error', { error: (err as Error).message }))
  }, config.interval * 1000)
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message)
  process.exit(1)
})
