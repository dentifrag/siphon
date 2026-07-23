import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction
} from 'fastify'
import {
  AuthAlreadyConfiguredError,
  AuthCurrentPasswordMismatchError,
  AuthNotPasswordModeError,
  AuthPasswordChangeNotAllowedError,
  type AuthService
} from '../auth'
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

function readSessionIds(req: FastifyRequest): string[] {
  const values = [req.cookies?.[SECURE_COOKIE], req.cookies?.[STANDARD_COOKIE]].filter(
    (value): value is string => Boolean(value)
  )
  return Array.from(new Set(values))
}

function apiPath(url: string): string {
  const queryIndex = url.indexOf('?')
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url
}

function reject(reply: FastifyReply, code: number, error: string): void {
  reply.header('Cache-Control', 'no-store').code(code).send({ error })
}

export function authGuard(auth: AuthService) {
  return (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const path = apiPath(req.url)
    if (!path.startsWith('/api/')) return done()

    const state = auth.state
    if (state === 'setup') {
      if (path === '/api/setup' || path === '/api/auth-status') return done()
      reject(reply, 403, 'Setup required')
      return
    }

    if (state === 'open') {
      if (path === '/api/setup') {
        reject(reply, 409, 'Already configured')
        return
      }
      if (path === '/api/change-password') {
        reject(reply, 409, 'Not available in open mode')
        return
      }
      return done()
    }

    if (path === '/api/setup') {
      reject(reply, 409, 'Already configured')
      return
    }
    if (path === '/api/login' || path === '/api/auth-status') return done()

    if (!readSessionIds(req).some((sid) => auth.isValid(sid))) {
      reject(reply, 401, 'Unauthorized')
      return
    }
    done()
  }
}

function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
  sid: string
): void {
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

function requiresJson(req: FastifyRequest, reply: FastifyReply): boolean {
  const contentType = req.headers['content-type']
  if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
    reject(reply, 415, 'Expected application/json')
    return false
  }
  return true
}

function sameOrigin(req: FastifyRequest): boolean {
  const originHeader = req.headers.origin
  if (!originHeader) return true
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (!origin) return false
  const host = req.headers.host
  if (!host) return false
  try {
    const parsed = new URL(origin)
    return parsed.protocol === `${req.protocol}:` && parsed.host === host
  } catch {
    return false
  }
}

const USERNAME_MAX = 64
const PASSWORD_MIN = 8
const PASSWORD_MAX = 256

export function registerAuthRoutes(app: FastifyInstance, { auth, config, limiter }: RouteContext): void {
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    reply.header('Cache-Control', 'no-store')
    const passwordState = auth.state === 'password'
    const key = req.ip
    if (passwordState) {
      const lock = limiter.check(key)
      if (lock.locked) {
        const retryAfterSeconds = Math.ceil(lock.retryAfterMs / 1_000)
        reply
          .header('Retry-After', String(retryAfterSeconds))
          .code(429)
          .send({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
        return
      }
    }

    const sid = await auth.login(String(body.username ?? ''), String(body.password ?? ''))

    if (passwordState && !sid) {
      limiter.recordFailure(key)
      return reply.code(401).send({ error: 'Invalid username or password' })
    }

    if (sid) {
      limiter.recordSuccess(key)
      setSessionCookie(req, reply, config, sid)
    }
    return { ok: true }
  })

  app.post('/api/logout', async (req, reply) => {
    for (const sid of readSessionIds(req)) auth.logout(sid)
    reply.clearCookie(STANDARD_COOKIE, { path: '/' })
    reply.clearCookie(SECURE_COOKIE, { path: '/', secure: true })
    return { ok: true }
  })

  app.get('/api/auth-status', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const state = auth.state
    const authenticated =
      state === 'password' ? readSessionIds(req).some((sid) => auth.isValid(sid)) : false
    return {
      state,
      required: state === 'password',
      authenticated,
      canChangePassword: auth.canChangePassword
    }
  })

  app.post('/api/setup', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!requiresJson(req, reply)) return
    if (!sameOrigin(req)) {
      reject(reply, 403, 'Forbidden origin')
      return
    }

    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; mode?: unknown }
    try {
      if (body.mode === 'open') {
        await auth.completeSetup({ mode: 'open' })
        return { ok: true }
      }

      const username = typeof body.username === 'string' ? body.username.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (username.length < 1 || username.length > USERNAME_MAX) {
        return reply.code(400).send({ error: `Username must be 1 to ${USERNAME_MAX} characters.` })
      }
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return reply
          .code(400)
          .send({ error: `Password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` })
      }
      const sid = await auth.completeSetup({ username, password })
      if (sid) setSessionCookie(req, reply, config, sid)
      return { ok: true }
    } catch (error) {
      if (error instanceof AuthAlreadyConfiguredError) {
        return reply.code(409).send({ error: 'Already configured' })
      }
      throw error
    }
  })

  app.post('/api/change-password', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!auth.canChangePassword) {
      return reply.code(409).send({ error: 'Not available in open mode' })
    }
    if (!requiresJson(req, reply)) return
    const key = req.ip
    const lock = limiter.check(key)
    if (lock.locked) {
      const retryAfterSeconds = Math.ceil(lock.retryAfterMs / 1_000)
      reply
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
      return
    }
    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown }
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    if (currentPassword.length < 1 || currentPassword.length > PASSWORD_MAX) {
      return reply.code(400).send({ error: `Current password must be 1 to ${PASSWORD_MAX} characters.` })
    }
    if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      return reply
        .code(400)
        .send({ error: `New password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` })
    }
    try {
      const sid = await auth.changePassword(currentPassword, newPassword)
      limiter.recordSuccess(key)
      setSessionCookie(req, reply, config, sid)
      return { ok: true }
    } catch (error) {
      if (error instanceof AuthCurrentPasswordMismatchError) {
        limiter.recordFailure(key)
        return reply.code(401).send({ error: 'Current password is incorrect' })
      }
      if (error instanceof AuthPasswordChangeNotAllowedError) {
        return reply.code(409).send({ error: 'Password changes are not allowed for this configuration' })
      }
      if (error instanceof AuthNotPasswordModeError) {
        return reply.code(409).send({ error: 'Not available in open mode' })
      }
      throw error
    }
  })
}
