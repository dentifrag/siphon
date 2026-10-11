import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect, createServer as createTcpServer, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ViteDevServer } from 'vite'
import { engines } from '../package.json'
import { resolveRcloneBinary } from '../src/server/rclone/binary'
import { createDevConfig, prepareDevFiles } from './dev-config'

const HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 30_000
const windowsChildWrapper = `
const { spawn, spawnSync } = require('node:child_process')
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
process.on('disconnect', () => {
  spawnSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true })
})
setInterval(() => {}, 60_000)
const child = spawn(process.argv[1], JSON.parse(process.argv[2]), {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true
})
child.on('error', (error) => process.send?.({ error: error.message }))
child.on('exit', (code, signal) => process.send?.({
  error: 'exited with ' + (signal ? 'signal ' + signal : 'code ' + code)
}))
`

interface OwnedChild {
  child: ChildProcess
  name: string
}

const children: OwnedChild[] = []
const abort = new AbortController()
let vite: ViteDevServer | undefined
let stopping: Promise<never> | undefined

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertActive(): void {
  abort.signal.throwIfAborted()
}

function supportedNode(): void {
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  if (
    major >= 26 ||
    (major === 24 && minor >= 15) ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
  ) {
    return
  }
  throw new Error(
    `npm run dev requires Node.js ${engines.node}; current version is ${process.versions.node}. Install a supported Node.js version and try again.`
  )
}

async function preflightPorts(ports: [string, number][]): Promise<void> {
  const reservations: Server[] = []
  try {
    for (const [name, port] of ports) {
      assertActive()
      const server = createTcpServer()
      reservations.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error) => {
          reject(
            new Error(
              `${name}: cannot listen on ${HOST}:${port} (${reason(error)}). Choose a free DEV_${name}_PORT.`
            )
          )
        })
        server.listen({ host: HOST, port, exclusive: true }, resolve)
      })
    }
  } finally {
    await Promise.all(
      reservations
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()))
            })
        )
    )
  }
}

function startChild(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): void {
  assertActive()
  const windows = process.platform === 'win32'
  const child = windows
    ? spawn(process.execPath, ['-e', windowsChildWrapper, command, JSON.stringify(args)], {
        cwd,
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true
      })
    : spawn(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  children.push({ child, name })
  child.on('error', (error) => fail(new Error(`${name} could not start: ${reason(error)}`)))
  child.on('exit', (code, signal) => {
    fail(new Error(`${name} exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
  })
  if (windows) {
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'error' in message) {
        fail(new Error(`${name}: ${String(message.error)}`))
      }
    })
  }
}

function signalTree(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function stopTree({ child, name }: OwnedChild): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000
    })
    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not stop ${name} process tree ${pid}: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || `taskkill exited with ${result.status}`}`
      )
    }
    return
  }
  if (!signalTree(pid, 'SIGTERM')) return
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await delay(100)
    if (!signalTree(pid, 0)) return
  }
  signalTree(pid, 'SIGKILL')
}

function stop(code: number): Promise<never> {
  if (stopping) return stopping
  abort.abort()
  stopping = (async () => {
    const results = await Promise.allSettled([
      ...children.map(stopTree),
      ...(vite ? [vite.close()] : [])
    ])
    let failed = false
    for (const result of results) {
      if (result.status === 'rejected') {
        failed = true
        console.error(`[dev] Shutdown failed: ${reason(result.reason)}`)
      }
    }
    process.exit(failed ? 1 : code)
  })()
  return stopping
}

function fail(error: unknown): void {
  if (stopping) return
  console.error(`\n[dev] ${reason(error)}\n`)
  void stop(1)
}

async function apiReady(url: string): Promise<void> {
  const response = await fetch(`${url}/api/auth-status`, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)])
  })
  if (!response.ok) throw new Error(`auth-status returned HTTP ${response.status}`)
  const status: unknown = await response.json()
  if (
    typeof status !== 'object' ||
    status === null ||
    !('state' in status) ||
    !['setup', 'open', 'password'].includes(String(status.state))
  ) {
    throw new Error('auth-status did not return a Siphon auth state')
  }
}

function sftpReady(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port })
    let banner = ''
    const finish = (error?: Error): void => {
      abort.signal.removeEventListener('abort', canceled)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const canceled = (): void => finish(new Error('Startup canceled'))
    abort.signal.addEventListener('abort', canceled, { once: true })
    socket.setTimeout(1000, () => finish(new Error('SFTP handshake timed out')))
    socket.once('error', finish)
    socket.once('end', () => finish(new Error('SFTP closed before its SSH handshake')))
    socket.on('data', (data: Buffer) => {
      banner += data.toString('utf8')
      if (banner.includes('\n')) {
        finish(banner.startsWith('SSH-2.0-') ? undefined : new Error('Invalid SFTP SSH handshake'))
      } else if (banner.length > 1024) {
        finish(new Error('Invalid SFTP SSH handshake'))
      }
    })
  })
}

async function waitUntilReady(name: string, check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    assertActive()
    try {
      await check()
      return
    } catch (error) {
      lastError = error
    }
    await delay(150, undefined, { signal: abort.signal })
  }
  throw new Error(`${name} was not ready within 30 seconds: ${reason(lastError)}`)
}

async function monitorApi(url: string): Promise<void> {
  let unavailableSince: number | undefined
  while (!abort.signal.aborted) {
    await delay(1000, undefined, { signal: abort.signal })
    try {
      await apiReady(url)
      unavailableSince = undefined
    } catch (error) {
      assertActive()
      unavailableSince ??= Date.now()
      if (Date.now() - unavailableSince >= 20_000) {
        throw new Error(`API stayed unavailable after a watch restart: ${reason(error)}`)
      }
    }
  }
}

async function main(): Promise<void> {
  supportedNode()
  const config = createDevConfig(process.cwd(), process.env)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, config.serverEnv)
  await preflightPorts([
    ['API', config.apiPort],
    ['UI', config.uiPort],
    ['SFTP', config.sftpPort]
  ])
  assertActive()
  const credentials = await prepareDevFiles(config)
  assertActive()
  console.log('[dev] Resolving rclone (the first run may download it)...')
  const binary = await resolveRcloneBinary(config.dataDir, dirname(process.execPath))
  assertActive()
  const env = { ...config.serverEnv, RCLONE_PATH: binary, RCLONE_CACHE_DIR: config.cacheDir }
  startChild(
    'Local SFTP',
    binary,
    [
      'serve',
      'sftp',
      config.remoteDir,
      '--addr',
      `${HOST}:${config.sftpPort}`,
      '--user',
      credentials.username,
      '--pass',
      credentials.password,
      '--config',
      config.rcloneConfigPath,
      '--cache-dir',
      config.cacheDir,
      '--authorized-keys',
      config.authorizedKeysPath,
      '--dir-cache-time',
      '0s'
    ],
    config.rootDir,
    env
  )
  const require = createRequire(join(config.rootDir, 'package.json'))
  startChild(
    'API watcher',
    process.execPath,
    [require.resolve('tsx/cli'), 'watch', join(config.rootDir, 'src', 'server', 'index.ts')],
    config.rootDir,
    env
  )
  const apiUrl = `http://${HOST}:${config.apiPort}`
  await Promise.all([
    waitUntilReady('Local SFTP', () => sftpReady(config.sftpPort)),
    waitUntilReady('API', () => apiReady(apiUrl))
  ])
  assertActive()
  const { createServer } = await import('vite')
  assertActive()
  vite = await createServer({
    configFile: join(config.rootDir, 'vite.web.config.ts'),
    configLoader: 'runner',
    cacheDir: join(config.cacheDir, 'vite'),
    server: {
      host: HOST,
      port: config.uiPort,
      strictPort: true,
      open: false,
      proxy: { '/api/': { target: apiUrl, changeOrigin: false } }
    }
  })
  assertActive()
  vite.httpServer?.on('error', fail)
  await vite.listen()
  assertActive()
  console.log(
    [
      '',
      `Siphon dev is ready: http://${HOST}:${config.uiPort}`,
      `Dev-only state: ${config.workspaceDir}`,
      'First run: finish the normal app setup in the browser.',
      '',
      'Connect using the normal SFTP connection form:',
      `  Host: ${HOST}`,
      `  Port: ${config.sftpPort}`,
      `  Username: ${credentials.username}`,
      `  Password: ${credentials.password}`,
      `Sample remote: ${config.remoteDir}`,
      `Local downloads and upload sample: ${config.downloadsDir}`,
      '',
      'Press Ctrl+C to stop the UI, API, and all owned rclone processes.',
      ''
    ].join('\n')
  )
  void monitorApi(apiUrl).catch((error) => {
    if (!abort.signal.aborted) fail(error)
  })
}

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
if (process.platform === 'win32') process.on('SIGBREAK', () => void stop(0))
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
void main().catch(fail)
