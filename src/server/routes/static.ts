import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../context'

export async function registerStatic(app: FastifyInstance, { execDir }: RouteContext): Promise<void> {
  const webDir = [
    process.env.WEB_DIR,
    join(__dirname, '..', 'dist-web'),
    join(execDir, 'public'),
    join(execDir, 'dist-web'),
    join(process.cwd(), 'dist-web')
  ]
    .filter((dir): dir is string => Boolean(dir))
    .find((dir) => existsSync(join(dir, 'index.html')))
  if (!webDir) return

  await app.register(fastifyStatic, { root: webDir })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' })
      return
    }
    reply.sendFile('index.html')
  })
}
