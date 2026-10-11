import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { expect, it } from 'vitest'
import webConfig from '../vite.web.config'

it('serves api.ts as JavaScript and proxies API routes without changing Host or Origin', async () => {
  const fixture = await mkdtemp(join(process.cwd(), '.siphon-vite-proxy-test-'))
  const apiRequests: string[] = []
  const api = createHttpServer((request, response) => {
    apiRequests.push(request.url ?? '')
    response.writeHead(request.url === '/api/status' ? 200 : 404, {
      'Content-Type': 'application/json'
    })
    response.end(
      JSON.stringify({
        url: request.url,
        host: request.headers.host,
        origin: request.headers.origin
      })
    )
  })
  let vite: ViteDevServer | undefined
  try {
    await writeFile(join(fixture, 'api.ts'), 'export const fixtureModule: string = "UI module"\n')
    await new Promise<void>((resolve, reject) => {
      api.once('error', reject)
      api.listen(0, '127.0.0.1', resolve)
    })
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const proxy = Object.fromEntries(
      Object.entries(webConfig.server!.proxy!).map(([key, options]) => {
        if (typeof options === 'string') {
          throw new Error('Expected object proxy options in vite.web.config.ts')
        }
        return [key, { ...options, target: apiUrl }]
      })
    )
    vite = await createServer({
      ...webConfig,
      configFile: false,
      root: fixture,
      cacheDir: join(fixture, '.vite'),
      plugins: [],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...webConfig.server,
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        open: false,
        watch: null,
        ws: false,
        proxy
      }
    })
    await vite.listen()
    const uiHost = `127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
    const uiOrigin = `http://${uiHost}`
    const moduleResponse = await fetch(`${uiOrigin}/api.ts`, {
      signal: AbortSignal.timeout(10_000)
    })
    expect(moduleResponse.status).toBe(200)
    expect(moduleResponse.headers.get('content-type')).toMatch(/javascript/)
    expect(await moduleResponse.text()).toContain('UI module')
    expect(apiRequests).toEqual([])

    const apiResponse = await fetch(`${uiOrigin}/api/status`, {
      headers: { Origin: uiOrigin },
      signal: AbortSignal.timeout(10_000)
    })
    expect(apiResponse.status).toBe(200)
    expect(await apiResponse.json()).toEqual({
      url: '/api/status',
      host: uiHost,
      origin: uiOrigin
    })
    expect(apiRequests).toEqual(['/api/status'])
  } finally {
    try {
      await vite?.close()
    } finally {
      try {
        if (api.listening) {
          await new Promise<void>((resolve, reject) => {
            api.close((error) => (error ? reject(error) : resolve()))
          })
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  }
}, 30_000)
