import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'
import { httpError, parseConnectionRevision } from '../http'
import { remoteType, toRemoteEntry, uiToRemotePath } from '../mapping'

export function registerBrowseRoutes(
  app: FastifyInstance,
  { services, session }: RouteContext
): void {
  app.get('/api/list', async (req) => {
    const query = req.query as { path?: string; connectionRevision?: unknown }
    const dir = query.path || '/'
    const binding = session.bind(parseConnectionRevision(query.connectionRevision))
    let entries
    try {
      entries = await services.client.list(binding.fs, uiToRemotePath(dir))
    } catch (error) {
      session.assertCurrent(binding)
      throw error
    }
    session.assertCurrent(binding)
    return entries
      .map((entry) => toRemoteEntry(dir, entry))
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
  })

  app.get('/api/stat', async (req) => {
    const query = req.query as { path?: string; connectionRevision?: unknown }
    const path = query.path
    const expectedRevision = parseConnectionRevision(query.connectionRevision)
    if (!path) throw httpError(400, 'A path is required.')
    const binding = session.bind(expectedRevision)
    let item
    try {
      item = await services.client.stat(binding.fs, uiToRemotePath(path))
    } catch (error) {
      session.assertCurrent(binding)
      throw error
    }
    session.assertCurrent(binding)
    if (!item) throw httpError(404, 'Not found.')
    return {
      size: item.Size < 0 ? 0 : item.Size,
      type: remoteType(item),
      mtime: Date.parse(item.ModTime) || 0
    }
  })
}
