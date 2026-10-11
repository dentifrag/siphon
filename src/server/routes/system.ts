import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'
import { listDirs, makeDir, type FsScope } from '../localFs'
import { currentVersion } from '../version'

export function registerSystemRoutes(
  app: FastifyInstance,
  { config, updates }: RouteContext
): void {
  const scope: FsScope = {
    roots: config.roots,
    confined: config.confined,
    excludedPaths: updates?.protectedPaths
  }

  app.get('/api/health', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { app: 'siphon', version: currentVersion }
  })

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
