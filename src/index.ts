import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { execSync, type ExecSyncOptions } from 'child_process'
import { join, dirname } from 'path'
import { parse as parseYaml } from 'yaml'
import { createServer } from 'http'

// ─── Types ───────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type RepoConfig = {
  url: string
  path: string
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

// ─── Git Operations ──────────────────────────────────────────────────────────

function getExecOpts(cwd?: string): ExecSyncOptions {
  return {
    cwd,
    stdio: config.log_level === 'debug' ? 'inherit' : 'pipe',
    env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand() },
    timeout: 300_000,
  }
}

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

function run(cmd: string, cwd?: string): string {
  log('debug', `$ ${cmd}`, { cwd })
  try {
    return execSync(cmd, getExecOpts(cwd)).toString().trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`Command failed: ${cmd}\n${stderr}`)
  }
}

function cloneRepo(repo: RepoConfig, fullPath: string): void {
  const parentDir = dirname(fullPath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  const depthArg = repo.depth ? `--depth ${repo.depth}` : ''
  const refArg = repo.ref && repo.ref !== 'HEAD' ? `--branch ${repo.ref}` : ''

  log('info', `Cloning ${repo.url} -> ${fullPath}`)
  run(`git clone ${depthArg} ${refArg} ${repo.url} ${fullPath}`)

  if (!repo.depth) {
    run('git fetch --all -q', fullPath)
  }
}

function syncRepo(repo: RepoConfig, fullPath: string): { hash: string; branches: string[] } {
  log('debug', `Fetching ${repo.url}`)
  run('git fetch --all --prune -q', fullPath)

  try {
    const branch = run('git symbolic-ref --short HEAD', fullPath)
    if (branch) {
      run('git pull --ff-only -q', fullPath)
    }
  } catch {
    // Detached HEAD — skip pull
  }

  const hash = run('git rev-parse HEAD', fullPath)
  const branchesRaw = run("git branch -a --format='%(refname:short)'", fullPath)
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

function runPostSync(repo: RepoConfig, fullPath: string): void {
  if (!repo.post_sync?.length) return

  for (const cmd of repo.post_sync) {
    try {
      log('debug', `Running post-sync: ${cmd}`)
      run(cmd, fullPath)
    } catch (err) {
      log('warn', `Post-sync command failed: ${cmd}`, { error: (err as Error).message })
    }
  }
}

// ─── Sync Loop ───────────────────────────────────────────────────────────────

function setupGit(): void {
  if (config.git_user_name) {
    run(`git config --global user.name "${config.git_user_name}"`)
  }
  if (config.git_user_email) {
    run(`git config --global user.email "${config.git_user_email}"`)
  }
  run(`git config --global --add safe.directory '*'`)
}

async function syncAll(): Promise<void> {
  const enabledRepos = config.repos.filter((r) => r.enabled !== false)
  log('info', `Syncing ${enabledRepos.length} repos...`)

  for (const repo of enabledRepos) {
    const fullPath = join(config.workspace, repo.path)
    const status: SyncStatus = syncStatuses.get(repo.url) ?? {
      repo: repo.url,
      path: fullPath,
      last_sync: null,
      last_hash: null,
      status: 'pending',
    }

    try {
      if (!existsSync(join(fullPath, '.git'))) {
        cloneRepo(repo, fullPath)
      }

      const { hash, branches } = syncRepo(repo, fullPath)

      if (hash !== status.last_hash) {
        log('info', `Updated ${repo.path}`, { hash: hash.slice(0, 8), branches: branches.length })
        copyEnvFiles(repo, fullPath)
        runPostSync(repo, fullPath)
      } else {
        log('debug', `No changes: ${repo.path}`)
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

  log('info', 'repo-sync starting', {
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
