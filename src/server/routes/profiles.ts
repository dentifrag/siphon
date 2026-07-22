import type { FastifyInstance } from 'fastify'
import type { SaveProfileInput } from '../../shared/api'
import type { RouteContext } from '../context'

export function registerProfileRoutes(app: FastifyInstance, { services }: RouteContext): void {
  const { remotes } = services

  app.get('/api/profiles', async () => remotes.list())

  app.post('/api/profiles', async (req) => {
    const input = req.body as SaveProfileInput
    const password = input.authMethod === 'password' ? input.secret : undefined
    const passphrase = input.authMethod === 'privateKey' ? input.secret : undefined
    return remotes.save({ ...input, password, passphrase })
  })

  app.post('/api/profiles/resolve', async (req) => remotes.resolve((req.body as { id: string }).id))

  app.post('/api/profiles/delete', async (req) => remotes.delete((req.body as { id: string }).id))
}
