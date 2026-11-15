import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderr = new EventEmitter()
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  })
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
}))
vi.mock('node:fs/promises', () => ({ mkdir: async () => undefined }))
vi.mock('node:net', () => ({
  createServer: () => {
    const server = {
      unref: () => server,
      on: () => server,
      address: () => ({ port: 4567 }),
      listen: (_port: number, _host: string, cb: () => void) => cb(),
      close: (cb: () => void) => cb()
    }
    return server
  }
}))
vi.mock('../src/server/rclone/binary', () => ({ resolveRcloneBinary: async () => 'rclone' }))

import { RcloneSupervisor } from '../src/server/rclone/supervisor'

describe('RcloneSupervisor', () => {
  beforeEach(() => {
    children.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not expose the endpoint of a daemon that exited by signal while readiness was pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        children[0].signalCode = 'SIGKILL'
        children[0].emit('exit', null, 'SIGKILL')
        return new Response('{}')
      })
    )
    const supervisor = new RcloneSupervisor('/tmp/siphon-supervisor-test', '/tmp')
    await supervisor.start()
    expect(() => supervisor.getEndpoint()).toThrow('not running')
    await supervisor.stop()
  })

  it('stops a daemon that misses the readiness deadline so it is restarted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const log = vi.fn()
    const supervisor = new RcloneSupervisor('/tmp/siphon-supervisor-test', '/tmp', log)
    const started = supervisor.start().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await started).toBeInstanceOf(Error)
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(2)
    await supervisor.stop()
  })
})
