import fastifyCookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import type { RouteContext } from './context'
import { authGuard, registerAuthRoutes } from './routes/auth'
import { registerSystemRoutes } from './routes/system'
import { registerConnectionRoutes } from './routes/connection'
import { registerBrowseRoutes } from './routes/browse'
import { registerDownloadRoutes } from './routes/downloads'
import { registerProfileRoutes } from './routes/profiles'
import { registerStatic } from './routes/static'

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await app.register(fastifyCookie)
  app.addHook('preHandler', authGuard(ctx.auth))
  registerAuthRoutes(app, ctx)
  registerSystemRoutes(app, ctx)
  registerConnectionRoutes(app, ctx)
  registerBrowseRoutes(app, ctx)
  registerDownloadRoutes(app, ctx)
  registerProfileRoutes(app, ctx)
  await registerStatic(app, ctx)
}
