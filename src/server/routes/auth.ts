import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction
} from 'fastify'
import type { AuthService } from '../auth'
import type { RouteContext } from '../context'
import type { ServerConfig } from '../config'

const SECURE_COOKIE = '__Host-siphon_sid'
const STANDARD_COOKIE = 'siphon_sid'

export function resolveSecure(req: FastifyRequest, config: ServerConfig): boolean {
  if (config.secureCookies === 'true') return true
  if (config.secureCookies === 'false') return false
  return req.protocol === 'https'
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE : STANDARD_COOKIE
}

function readSessionId(req: FastifyRequest): string | undefined {
  return req.cookies?.[SECURE_COOKIE] ?? req.cookies?.[STANDARD_COOKIE]
}

export function authGuard(auth: AuthService) {
  return (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    if (!req.url.startsWith('/api/')) return done()
    if (req.url.startsWith('/api/login') || req.url.startsWith('/api/auth-status')) return done()
    if (!auth.isValid(readSessionId(req))) {
      reply.header('Cache-Control', 'no-store').code(401).send({ error: 'Unauthorized' })
      return
    }
    done()
  }
}

export function registerAuthRoutes(app: FastifyInstance, { auth, config, limiter }: RouteContext): void {
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    const key = req.ip
    const lock = limiter.check(key)
    if (lock.locked) {
      const retryAfterSeconds = Math.ceil(lock.retryAfterMs / 1_000)
      reply
        .header('Cache-Control', 'no-store')
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
      return
    }

    const sid = auth.login(String(body.username ?? ''), String(body.password ?? ''))
    reply.header('Cache-Control', 'no-store')

    if (auth.enabled && !sid) {
      limiter.recordFailure(key)
      return reply.code(401).send({ error: 'Invalid username or password' })
    }

    if (sid) {
      limiter.recordSuccess(key)
      const secure = resolveSecure(req, config)
      const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1_000
      reply.setCookie(sessionCookieName(secure), sid, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure,
        maxAge: Math.floor(sessionTtlMs / 1_000)
      })
    }
    return { ok: true }
  })

  app.post('/api/logout', async (req, reply) => {
    auth.logout(readSessionId(req))
    reply.clearCookie(STANDARD_COOKIE, { path: '/' })
    reply.clearCookie(SECURE_COOKIE, { path: '/', secure: true })
    return { ok: true }
  })

  app.get('/api/auth-status', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      required: auth.enabled,
      authenticated: auth.isValid(readSessionId(req))
    }
  })
}
