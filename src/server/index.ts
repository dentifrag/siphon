import Fastify from 'fastify'
import { dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { loadConfig } from './config'
import { AuthService, hashPassword, type AuthStartup } from './auth'
import { AuthStore } from './authStore'
import { LoginLimiter } from './loginLimiter'
import { createServices } from './services'
import { ConnectionSession } from './session'
import { registerRoutes } from './app'
import { RcloneUnavailableError } from './rclone/binary'

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

async function readPasswordFromPrompt(): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== 'function'
  ) {
    throw new Error('Interactive password input requires a TTY')
  }
  const stdin = process.stdin
  const stdout = process.stdout
  const wasRaw = stdin.isRaw
  stdin.setEncoding('utf8')
  stdin.resume()
  stdout.write('Password: ')
  stdin.setRawMode(true)
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = ''
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === '\u0003') {
            stdin.off('data', onData)
            reject(new Error('Canceled'))
            return
          }
          if (char === '\r' || char === '\n') {
            stdin.off('data', onData)
            stdout.write('\n')
            resolve(password)
            return
          }
          if (char === '\u007f' || char === '\b') {
            password = password.slice(0, -1)
            continue
          }
          password += char
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(wasRaw)
    stdin.pause()
  }
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/[\r\n]+$/, '')
}

async function main(): Promise<void> {
  if (process.argv.includes('--hash-password')) {
    const password = process.stdin.isTTY
      ? await readPasswordFromPrompt()
      : await readPasswordFromStdin()
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${hashPassword(password)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    return
  }

  const { config, configPath, created } = loadConfig()
  const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1_000
  const authStore = new AuthStore(config.dataDir)
  const hasConfiguredCredential = Boolean(config.appPassword) || Boolean(config.appPasswordHash)

  let startup: AuthStartup
  if (hasConfiguredCredential) {
    const username = config.appUsername ?? 'admin'
    const passwordHash = config.appPasswordHash ?? hashPassword(config.appPassword ?? '')
    startup = { mode: 'password', username, passwordHash, canChangePassword: false }
  } else {
    let stored
    try {
      stored = await authStore.read()
    } catch (error) {
      throw new Error(
        `Failed to read auth state from ${authStore.path()}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!stored) startup = { mode: 'setup' }
    else if (stored.mode === 'open') startup = { mode: 'open' }
    else {
      startup = {
        mode: 'password',
        username: stored.username,
        passwordHash: stored.passwordHash,
        canChangePassword: true
      }
    }
  }

  const auth = new AuthService({
    startup,
    store: authStore,
    sessionTtlMs
  })
  const limiter = new LoginLimiter({
    maxAttempts: config.loginMaxAttempts,
    lockoutMs: config.loginLockoutMinutes * 60 * 1_000
  })

  const app = Fastify({ bodyLimit: 5 * 1_024 * 1_024, logger: true, trustProxy: config.trustProxy })
  try {
    mkdirSync(config.defaultDir, { recursive: true })
  } catch (err) {
    app.log.warn(
      `Could not create the default download folder ${config.defaultDir} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'Downloads there will fail until it exists or you pick another folder.'
    )
  }
  const execDir = dirname(process.execPath)
  const services = await createServices(config, execDir, (message) => app.log.info(message))
  const session = new ConnectionSession(services)
  await registerRoutes(app, { config, auth, limiter, services, session, execDir })

  const shutdown = async (): Promise<void> => {
    await services.supervisor.stop().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await app.listen({ port: config.port, host: config.host })
  if (created && configPath) {
    app.log.warn(`First run: created a config file at ${configPath}. Edit it and restart.`)
  } else if (configPath) {
    app.log.info(`Config file: ${configPath}`)
  }

  if (hasConfiguredCredential && existsSync(authStore.path())) {
    app.log.warn(
      `Auth store found at ${authStore.path()}, but APP_PASSWORD / APP_PASSWORD_HASH or a configured appPassword/appPasswordHash is set. Stored auth is dormant until the override is removed.`
    )
  }

  app.log.info(`Auth state: ${auth.state} (canChangePassword=${auth.canChangePassword})`)
  app.log.info(
    `Auth network settings: secureCookies=${config.secureCookies}, trustProxy=${config.trustProxy}`
  )
  if (config.secureCookies === 'auto' && !config.trustProxy) {
    app.log.info('For HTTPS behind a proxy, set secureCookies=true or enable trustProxy.')
  }

  if (auth.state === 'setup') {
    app.log.warn('Setup mode: operational API routes are blocked until setup is completed.')
    if (!isLoopbackHost(config.host)) {
      app.log.warn('During setup, bind to loopback only unless your network is fully trusted.')
    }
  } else if (auth.state === 'open') {
    app.log.warn('Open mode is enabled. The web UI is unauthenticated.')
    if (!isLoopbackHost(config.host)) {
      app.log.warn('Warning: open mode UI is listening on a non-local interface.')
    }
  }

  app.log.info(`Engine: rclone (config at ${services.supervisor.configPath})`)
  if (config.confined) {
    app.log.info(
      `Download folders: ${config.roots.map((root) => `${root.name} (${root.path})`).join(', ')}`
    )
  } else {
    app.log.info(
      `Downloads default to ${config.defaultDir}; the folder picker can browse the whole computer.`
    )
  }
  app.log.info(`Open http://localhost:${config.port} in your browser.`)
  if (auth.state === 'setup') {
    app.log.warn(
      `Open http://localhost:${config.port} to finish setup before exposing Siphon to the internet.`
    )
  }
}

main().catch((error) => {
  if (error instanceof RcloneUnavailableError) {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  }
  console.error(error)
  process.exit(1)
})
