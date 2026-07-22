import { describe, expect, it } from 'vitest'
import { pushSample, rollingSpeed, type SpeedSample } from '../src/server/rclone/speed'

describe('rollingSpeed', () => {
  it('returns 0 with fewer than two samples', () => {
    expect(rollingSpeed([])).toBe(0)
    expect(rollingSpeed([{ time: 0, bytes: 0 }])).toBe(0)
  })

  it('averages bytes over the elapsed span', () => {

    const samples: SpeedSample[] = [
      { time: 0, bytes: 0 },
      { time: 2000, bytes: 10 * 1024 * 1024 }
    ]
    expect(rollingSpeed(samples, 3000)).toBeCloseTo(5 * 1024 * 1024, 5)
  })

  it('ignores samples older than the window', () => {

    const samples: SpeedSample[] = [
      { time: 0, bytes: 100 * 1024 * 1024 },
      { time: 2000, bytes: 100 * 1024 * 1024 },
      { time: 5000, bytes: 103 * 1024 * 1024 }
    ]
    expect(rollingSpeed(samples, 3000)).toBeCloseTo(1 * 1024 * 1024, 5)
  })

  it('is smoother than an instantaneous two-point delta', () => {

    const mb = 1024 * 1024
    const samples: SpeedSample[] = [
      { time: 0, bytes: 0 },
      { time: 250, bytes: 0 },
      { time: 500, bytes: mb },
      { time: 750, bytes: mb },
      { time: 1000, bytes: 2 * mb }
    ]
    const instantaneousLast = (2 * mb - mb) / 0.25
    const windowed = rollingSpeed(samples, 3000)
    expect(windowed).toBeLessThan(instantaneousLast)
    expect(windowed).toBeGreaterThan(0)
  })
})

describe('pushSample', () => {
  it('drops samples that age out but keeps one straddling the cutoff', () => {
    const samples: SpeedSample[] = []
    for (let t = 0; t <= 10000; t += 1000) {
      pushSample(samples, { time: t, bytes: t }, 3000)
    }
    const newest = samples[samples.length - 1]
    expect(samples[0].time).toBeGreaterThanOrEqual(newest.time - 3000 - 1000)
    expect(samples.length).toBeLessThanOrEqual(6)
    expect(newest.time).toBe(10000)
  })
})
