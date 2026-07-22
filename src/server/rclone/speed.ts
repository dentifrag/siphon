export interface SpeedSample {
  time: number
  bytes: number
}

export const SPEED_WINDOW_MS = 3000

export function rollingSpeed(samples: SpeedSample[], windowMs = SPEED_WINDOW_MS): number {
  if (samples.length < 2) return 0
  const newest = samples[samples.length - 1]
  const cutoff = newest.time - windowMs
  let oldest = samples[0]
  for (const sample of samples) {
    if (sample.time >= cutoff) {
      oldest = sample
      break
    }
  }
  const elapsed = (newest.time - oldest.time) / 1000
  if (elapsed <= 0) return 0
  return Math.max(0, (newest.bytes - oldest.bytes) / elapsed)
}

export function pushSample(
  samples: SpeedSample[],
  sample: SpeedSample,
  windowMs = SPEED_WINDOW_MS
): void {
  samples.push(sample)
  const cutoff = sample.time - windowMs
  while (samples.length > 2 && samples[1].time < cutoff) {
    samples.shift()
  }
}
