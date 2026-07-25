import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { sameOrigin } from '../src/server/routes/auth'

function req(input: { origin?: string; host?: string; hostname?: string }): FastifyRequest {
  return {
    headers: {
      origin: input.origin,
      host: input.host
    },
    host: input.host ?? '',
    hostname: input.hostname ?? ''
  } as unknown as FastifyRequest
}

describe('sameOrigin', () => {
  it('returns true when Origin header is missing', () => {
    expect(sameOrigin(req({ host: 'siphon.example.com' }))).toBe(true)
  })

  it('returns true when Origin host matches Host, regardless of protocol', () => {
    expect(
      sameOrigin(req({ origin: 'https://siphon.example.com', host: 'siphon.example.com' }))
    ).toBe(true)
    expect(
      sameOrigin(req({ origin: 'http://siphon.example.com:8080', host: 'siphon.example.com:8080' }))
    ).toBe(true)
  })

  it('returns false when Origin host differs from Host', () => {
    expect(sameOrigin(req({ origin: 'https://evil.com', host: 'siphon.example.com' }))).toBe(false)
  })

  it('returns false when Origin is malformed', () => {
    expect(sameOrigin(req({ origin: 'not a url', host: 'siphon.example.com' }))).toBe(false)
  })
})
