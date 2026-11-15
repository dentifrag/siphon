import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerProfileRoutes } from '../src/server/routes/profiles'
import type { RouteContext } from '../src/server/context'

async function makeApp() {
  const save = vi.fn().mockResolvedValue([])
  const app = Fastify()
  registerProfileRoutes(app, { services: { remotes: { save } } } as unknown as RouteContext)
  await app.ready()
  return { app, save }
}

const valid = {
  name: 'alice@host',
  host: 'host',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  rememberSecret: false,
  segments: 4,
  downloadDir: ''
}

describe('POST /api/profiles', () => {
  it.each([{ port: '22' }, { downloadDir: undefined }, { authMethod: 'token' }])(
    'rejects input the saved-site store could not read back: %j',
    async (override) => {
      const { app, save } = await makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { ...valid, ...override }
      })
      expect(response.statusCode).toBe(400)
      expect(save).not.toHaveBeenCalled()
      await app.close()
    }
  )

  it('saves valid input', async () => {
    const { app, save } = await makeApp()
    const response = await app.inject({ method: 'POST', url: '/api/profiles', payload: valid })
    expect(response.statusCode).toBe(200)
    expect(save).toHaveBeenCalledOnce()
    await app.close()
  })
})
