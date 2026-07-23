import Fastify from 'fastify'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { loadConfig } from './config'
import { AuthService, hashPassword } from './auth'
import { LoginLimiter } from './loginLimiter'
import { createServices } from './services'
import { ConnectionSession } from './session'
import { registerRoutes } from './app'
import { RcloneUnavailableError } from './rclone/binary'

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

async function readPasswordFromPrompt(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })
  try {
    return await rl.question('Password: ')
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const hashIndex = process.argv.indexOf('--hash-password')
  if (hashIndex >= 0) {
    const argValue = process.argv[hashIndex + 1]
    const password = argValue && !argValue.startsWith('--') ? argValue : await readPasswordFromPrompt()
    process.stdout.write(`${hashPassword(password)}\n`)
    process.exit(0)
  }

  const { config, configPath, created } = loadConfig()
  const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1_000
  const auth = new AuthService({
    username: config.appUsername,
    password: config.appPassword,
    passwordHash: config.appPasswordHash,
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

  if (auth.enabled) {
    app.log.info(`Authentication enabled (username: ${config.appUsername ?? 'admin'})`)
    app.log.info(`Auth network settings: secureCookies=${config.secureCookies}, trustProxy=${config.trustProxy}`)
    if (config.secureCookies === 'auto' && !config.trustProxy) {
      app.log.info('For HTTPS behind a proxy, set secureCookies=true or enable trustProxy.')
    }
  } else {
    app.log.warn('No password set: the web UI is unauthenticated. Set a password to protect it.')
    if (!isLoopbackHost(config.host)) {
      app.log.warn('Warning: unauthenticated UI is listening on a non-local interface.')
    }
  }

  app.log.info(`Engine: rclone (config at ${services.supervisor.configPath})`)
  if (config.confined) {
    app.log.info(`Download folders: ${config.roots.map((root) => `${root.name} (${root.path})`).join(', ')}`)
  } else {
    app.log.info(`Downloads default to ${config.defaultDir}; the folder picker can browse the whole computer.`)
  }
  app.log.info(`Open http://localhost:${config.port} in your browser.`)
}

main().catch((error) => {
  if (error instanceof RcloneUnavailableError) {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  }
  console.error(error)
  process.exit(1)
})
