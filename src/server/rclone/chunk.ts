export interface MultiThreadPlan {
  streams: number
  chunkBytes: number
  cutoffBytes: number
}

export interface MultiThreadConfig {
  MultiThreadStreams: number
  MultiThreadCutoff: string
  MultiThreadChunkSize: string
}

const MIN_CHUNK_BYTES = 5 * 1024 * 1024
const CUTOFF_BYTES = 1 * 1024 * 1024
export const MAX_STREAMS = 16

export function planMultiThread(size: number, segments: number): MultiThreadPlan {
  const requested = Math.max(1, Math.min(Math.floor(segments) || 1, MAX_STREAMS))
  if (size <= 0) {
    return { streams: 1, chunkBytes: MIN_CHUNK_BYTES, cutoffBytes: CUTOFF_BYTES }
  }
  const target = Math.ceil(size / requested)
  const chunkBytes = Math.max(MIN_CHUNK_BYTES, target)
  const effectiveStreams = Math.max(1, Math.min(requested, Math.ceil(size / chunkBytes)))
  return { streams: effectiveStreams, chunkBytes, cutoffBytes: CUTOFF_BYTES }
}

export function multiThreadConfig(plan: MultiThreadPlan): MultiThreadConfig {
  return {
    MultiThreadStreams: plan.streams,
    MultiThreadCutoff: `${plan.cutoffBytes}B`,
    MultiThreadChunkSize: `${plan.chunkBytes}B`
  }
}

export function planDirectoryMultiThread(segments: number): MultiThreadPlan {
  const streams = Math.max(1, Math.min(Math.floor(segments) || 1, MAX_STREAMS))
  return { streams, chunkBytes: MIN_CHUNK_BYTES, cutoffBytes: CUTOFF_BYTES }
}
