import type { FastifyInstance } from 'fastify'
import type { ConnectionConfig } from '../../shared/types'
import type { RouteContext } from '../context'

export function registerConnectionRoutes(app: FastifyInstance, { session }: RouteContext): void {
  app.get('/api/status', async () => session.status())

  app.post('/api/connect', async (req) => {
    const body = req.body as { config?: ConnectionConfig; profileId?: string }
    const connectionRevision = await session.connect(body)
    return { home: '/', connectionRevision }
  })

  app.post('/api/disconnect', async () => {
    await session.disconnect()
    return { ok: true }
  })
}
