import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'
import { listDirs, makeDir, type FsScope } from '../localFs'

export function registerSystemRoutes(app: FastifyInstance, { config }: RouteContext): void {
  const scope: FsScope = { roots: config.roots, confined: config.confined }

  app.get('/api/config', async () => ({
    downloadDir: config.defaultDir,
    roots: config.roots
  }))

  app.get('/api/fs/roots', async () => config.roots)

  app.get('/api/fs/list', async (req) =>
    listDirs(scope, (req.query as { path?: string }).path, config.defaultDir)
  )

  app.post('/api/fs/mkdir', async (req) => {
    const { path, name } = req.body as { path: string; name: string }
    return { path: await makeDir(scope, path, name) }
  })
}
