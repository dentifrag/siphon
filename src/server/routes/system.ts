import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'
import { listDirs, makeDir } from '../localFs'

export function registerSystemRoutes(app: FastifyInstance, { config }: RouteContext): void {
  app.get('/api/config', async () => ({
    downloadDir: config.roots[0].path,
    roots: config.roots
  }))

  app.get('/api/fs/roots', async () => config.roots)

  app.get('/api/fs/list', async (req) =>
    listDirs(config.roots, (req.query as { path?: string }).path)
  )

  app.post('/api/fs/mkdir', async (req) => {
    const { path, name } = req.body as { path: string; name: string }
    return { path: await makeDir(config.roots, path, name) }
  })
}
