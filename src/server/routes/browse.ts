import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'
import { httpError } from '../http'
import { remoteType, toRemoteEntry, uiToRemotePath } from '../mapping'

export function registerBrowseRoutes(
  app: FastifyInstance,
  { services, session }: RouteContext
): void {
  app.get('/api/list', async (req) => {
    const dir = (req.query as { path?: string }).path || '/'
    const entries = await services.client.list(session.remoteFs(), uiToRemotePath(dir))
    return entries
      .map((entry) => toRemoteEntry(dir, entry))
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
  })

  app.get('/api/stat', async (req) => {
    const path = (req.query as { path?: string }).path
    if (!path) throw httpError(400, 'A path is required.')
    const item = await services.client.stat(session.remoteFs(), uiToRemotePath(path))
    if (!item) throw httpError(404, 'Not found.')
    return {
      size: item.Size < 0 ? 0 : item.Size,
      type: remoteType(item),
      mtime: Date.parse(item.ModTime) || 0
    }
  })
}
