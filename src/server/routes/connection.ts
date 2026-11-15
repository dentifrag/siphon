import type { FastifyInstance } from 'fastify'
import type { ConnectionConfig } from '../../shared/types'
import type { RouteContext } from '../context'
import { httpError } from '../http'

export function registerConnectionRoutes(app: FastifyInstance, { session }: RouteContext): void {
  app.get('/api/status', async () => session.status())

  app.post('/api/connect', async (req) => {
    const body = req.body as { config?: ConnectionConfig; profileId?: string; secret?: string }
    const connectionRevision = await session.connect({
      ...body,
      secret: typeof body.secret === 'string' ? body.secret : undefined
    })
    const { connectionRevision: current, connection } = session.status()
    if (current !== connectionRevision || !connection) {
      throw httpError(
        409,
        'The connection changed. Reconnect before continuing.',
        'CONNECTION_CHANGED'
      )
    }
    return { home: '/', connectionRevision, connection }
  })

  app.post('/api/disconnect', async () => {
    await session.disconnect()
    return { ok: true }
  })
}
