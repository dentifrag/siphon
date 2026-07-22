import Fastify from 'fastify'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config'
import { AuthService } from './auth'
import { createServices } from './services'
import { ConnectionSession } from './session'
import { registerRoutes } from './app'

async function main(): Promise<void> {
  const { config, configPath, created } = loadConfig()
  const auth = new AuthService(config.appPassword)

  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: true })
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
  await registerRoutes(app, { config, auth, services, session, execDir })

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
  if (!auth.enabled) {
    app.log.warn('No password set: the web UI is unauthenticated. Set a password to protect it.')
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
  console.error(error)
  process.exit(1)
})
