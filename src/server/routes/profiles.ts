import type { FastifyInstance } from 'fastify'
import type { SaveProfileInput } from '../../shared/api'
import type { RouteContext } from '../context'
import { httpError } from '../http'

function validateSaveInput(value: unknown): SaveProfileInput {
  const r = (value ?? {}) as Record<string, unknown>
  const valid =
    typeof r.name === 'string' &&
    typeof r.host === 'string' &&
    r.host.trim() !== '' &&
    typeof r.port === 'number' &&
    Number.isInteger(r.port) &&
    r.port > 0 &&
    r.port <= 65535 &&
    typeof r.username === 'string' &&
    r.username !== '' &&
    (r.authMethod === 'password' || r.authMethod === 'privateKey') &&
    (r.privateKeyPath === undefined || typeof r.privateKeyPath === 'string') &&
    (r.secret === undefined || typeof r.secret === 'string') &&
    typeof r.rememberSecret === 'boolean' &&
    typeof r.segments === 'number' &&
    Number.isFinite(r.segments) &&
    typeof r.downloadDir === 'string'
  if (!valid) throw httpError(400, 'The connection settings are not valid.')
  return value as SaveProfileInput
}

export function registerProfileRoutes(app: FastifyInstance, { services }: RouteContext): void {
  const { remotes } = services

  app.get('/api/profiles', async () => remotes.list())

  app.post('/api/profiles', async (req) => {
    const input = validateSaveInput(req.body)
    const password = input.authMethod === 'password' ? input.secret : undefined
    const passphrase = input.authMethod === 'privateKey' ? input.secret : undefined
    return remotes.save({ ...input, password, passphrase })
  })

  app.post('/api/profiles/resolve', async (req) => remotes.resolve((req.body as { id: string }).id))

  app.post('/api/profiles/delete', async (req) => remotes.delete((req.body as { id: string }).id))
}
