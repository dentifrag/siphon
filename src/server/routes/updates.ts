import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UpdateStatus } from '../../shared/api'
import type { RouteContext } from '../context'
import { readSessionIds } from './auth'
import { currentVersion } from '../version'

export function registerUpdateRoutes(app: FastifyInstance, { auth, updates }: RouteContext) {
  function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
    reply.header('Cache-Control', 'no-store')
    if (auth.state !== 'password' || !readSessionIds(req).some((id) => auth.isValid(id))) {
      reply.code(auth.state === 'password' ? 401 : 403).send({
        error: 'Password authentication is required for Windows service updates.'
      })
      return false
    }
    const origin = req.headers.origin
    try {
      if (
        typeof origin !== 'string' ||
        origin !== new URL(origin).origin ||
        new URL(origin).origin !== `${req.protocol}://${req.host}`
      ) {
        throw new Error('Origin mismatch')
      }
    } catch {
      reply.code(403).send({ error: 'Forbidden origin' })
      return false
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reply.code(415).send({ error: 'Expected application/json' })
      return false
    }
    return true
  }

  function bodyObject(req: FastifyRequest, reply: FastifyReply) {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400).send({ error: 'Expected a JSON object.' })
      return null
    }
    return body as Record<string, unknown>
  }

  app.get('/api/updates/status', async (_req, reply): Promise<UpdateStatus> => {
    reply.header('Cache-Control', 'no-store')
    const status = updates
      ? await updates.status()
      : {
          currentVersion,
          capability: {
            supported: false as const,
            reason: 'not-windows-service' as const,
            message: 'Updates require an installed Windows service.'
          },
          check: { state: 'idle' as const },
          offer: null,
          job: null,
          maintenance: false,
          canInstall: false
        }
    return auth.state === 'password'
      ? status
      : {
          ...status,
          canInstall: false,
          canCheck: false,
          blockedReason: 'Password authentication is required for Windows service updates.'
        }
  })

  app.post('/api/updates/check', async (req, reply) => {
    if (!authorize(req, reply)) return
    const body = bodyObject(req, reply)
    if (!body) return
    if (Object.keys(body).length !== 0) {
      return reply.code(400).send({ error: 'Check does not accept any fields.' })
    }
    if (!updates) return reply.code(409).send({ error: 'Windows service updater is unavailable.' })
    return updates.check()
  })

  app.post('/api/updates/install', async (req, reply) => {
    if (!authorize(req, reply)) return
    const body = bodyObject(req, reply)
    if (!body) return
    if (
      Object.keys(body).length !== 1 ||
      typeof body.offerId !== 'string' ||
      !body.offerId.trim() ||
      body.offerId.length > 128
    ) {
      return reply.code(400).send({ error: 'Expected only a nonempty offerId.' })
    }
    if (!updates) return reply.code(409).send({ error: 'Windows service updater is unavailable.' })
    try {
      return reply.code(202).send(await updates.install(body.offerId))
    } catch (error) {
      if (error instanceof Error && 'accepted' in error && typeof error.accepted === 'boolean') {
        return reply.code(503).send({ error: error.message, accepted: error.accepted })
      }
      throw error
    }
  })

  app.post('/api/updates/retry', async (req, reply) => {
    if (!authorize(req, reply)) return
    const body = bodyObject(req, reply)
    if (!body) return
    if (Object.keys(body).length !== 0) {
      return reply.code(400).send({ error: 'Retry does not accept any fields.' })
    }
    if (!updates) return reply.code(409).send({ error: 'Windows service updater is unavailable.' })
    return reply.code(202).send(await updates.retryAcceptedTask())
  })
}
