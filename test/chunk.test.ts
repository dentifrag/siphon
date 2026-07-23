import { describe, expect, it } from 'vitest'
import { multiThreadConfig, planMultiThread, MAX_STREAMS } from '../src/server/rclone/chunk'

const MB = 1024 * 1024

describe('planMultiThread', () => {
  it('sizes the chunk so a large file yields the requested number of streams', () => {
    const plan = planMultiThread(100 * MB, 4)
    expect(plan.streams).toBe(4)
    expect(plan.chunkBytes).toBe(Math.ceil((100 * MB) / 4))
    expect(Math.ceil((100 * MB) / plan.chunkBytes)).toBe(4)
  })

  it('never asks for more streams than chunks the file can be split into', () => {
    const plan = planMultiThread(8 * MB, 8)
    expect(plan.chunkBytes).toBeGreaterThanOrEqual(5 * MB)
    expect(plan.streams).toBe(Math.ceil((8 * MB) / plan.chunkBytes))
    expect(plan.streams).toBeLessThanOrEqual(8)
  })

  it('clamps the requested segment count to the maximum', () => {
    const plan = planMultiThread(1024 * MB, 999)
    expect(plan.streams).toBeLessThanOrEqual(MAX_STREAMS)
    expect(plan.streams).toBe(MAX_STREAMS)
  })

  it('falls back to a single stream for tiny or unknown sizes', () => {
    expect(planMultiThread(0, 8).streams).toBe(1)
    expect(planMultiThread(-1, 8).streams).toBe(1)
    expect(planMultiThread(1 * MB, 8).streams).toBe(1)
  })

  it('treats a segment count of 1 as a single-stream download', () => {
    const plan = planMultiThread(500 * MB, 1)
    expect(plan.streams).toBe(1)
  })

  it('always reports a cutoff so small files skip multi-thread entirely', () => {
    const plan = planMultiThread(50 * MB, 4)
    expect(plan.cutoffBytes).toBeGreaterThan(0)
  })
})

describe('multiThreadConfig', () => {
  it('serializes byte sizes with an explicit B suffix so rclone reads them as bytes', () => {
    const plan = planMultiThread(100 * MB, 8)
    const config = multiThreadConfig(plan)
    expect(config.MultiThreadStreams).toBe(plan.streams)
    expect(config.MultiThreadCutoff).toBe(`${plan.cutoffBytes}B`)
    expect(config.MultiThreadChunkSize).toBe(`${plan.chunkBytes}B`)
    expect(config.MultiThreadChunkSize).toMatch(/^\d+B$/)
    expect(config.MultiThreadCutoff).toMatch(/^\d+B$/)
  })
})
