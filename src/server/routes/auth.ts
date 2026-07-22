import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction
} from 'fastify'
import type { AuthService } from '../auth'
import type { RouteContext } from '../context'

export function authGuard(auth: AuthService) {
  return (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    if (!req.url.startsWith('/api/')) return done()
    if (req.url.startsWith('/api/login') || req.url.startsWith('/api/auth-status')) return done()
    if (!auth.isValid(req.cookies?.sid)) {
      reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    done()
  }
}

export function registerAuthRoutes(app: FastifyInstance, { auth }: RouteContext): void {
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string }
    const sid = auth.login(String(body.password ?? ''))
    if (auth.enabled && !sid) return reply.code(401).send({ error: 'Invalid password' })
    if (sid) reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' })
    return { ok: true }
  })

  app.post('/api/logout', async (req, reply) => {
    auth.logout(req.cookies?.sid)
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth-status', async (req) => ({
    required: auth.enabled,
    authenticated: auth.isValid(req.cookies?.sid)
  }))
}
