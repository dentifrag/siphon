import type { RcloneEndpoint, RcloneSupervisor } from './supervisor'
import type { MultiThreadConfig } from './chunk'
import { httpError } from '../http'

export const MAX_RECURSIVE_LIST_ENTRIES = 10_000
export const MAX_RECURSIVE_LIST_BYTES = 32 * 1024 * 1024
export const RECURSIVE_LIST_TIMEOUT_MS = 35_000

async function readBoundedResponse(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        throw httpError(
          400,
          'The recursive folder listing exceeds the 32 MiB response limit.',
          'DOWNLOAD_LIST_TOO_LARGE'
        )
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

export interface RcloneListEntry {
  Path: string
  Name: string
  Size: number
  MimeType?: string
  ModTime: string
  IsDir: boolean
}

export interface RcloneStats {
  bytes?: number
  speed?: number
  transferring?: Array<{ name?: string; bytes?: number; size?: number; speed?: number }>
}

export interface RcloneJobStatus {
  finished: boolean
  success: boolean
  error: string
  id: number
  executeId?: string
}

export interface RcloneJobHandle {
  id: number
  executeId?: string
  endpoint: RcloneEndpoint
}

export class RcloneJobLostError extends Error {
  readonly code = 'RCLONE_JOB_LOST'

  constructor(message = 'rclone stopped or restarted. This transfer could not be completed.') {
    super(message)
    this.name = 'RcloneJobLostError'
  }
}

export type CopyFileConfig = MultiThreadConfig

export class RcloneClient {
  constructor(private readonly supervisor: RcloneSupervisor) {}

  private async call<T>(
    path: string,
    body: Record<string, unknown>,
    options: { timeoutMs?: number; maxResponseBytes?: number; endpoint?: RcloneEndpoint } = {}
  ): Promise<T> {
    const endpoint = options.endpoint ?? this.supervisor.getEndpoint()
    const assertCurrent = () => {
      if (options.endpoint && !this.supervisor.isEndpointCurrent(endpoint)) {
        throw new RcloneJobLostError()
      }
    }
    assertCurrent()
    const { baseUrl, authHeader } = endpoint
    const controller = new AbortController()
    const signal = options.timeoutMs
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs)])
      : controller.signal
    try {
      const res = await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      })
      const text = options.maxResponseBytes
        ? await readBoundedResponse(res, options.maxResponseBytes)
        : await res.text()
      assertCurrent()
      const data = text ? JSON.parse(text) : {}
      if (!res.ok) {
        const message = (data && (data.error as string)) || `rclone ${path} failed (${res.status})`
        if (path.startsWith('job/') && message === 'job not found') {
          throw new RcloneJobLostError(
            'rclone no longer has the result of this transfer. It was not published.'
          )
        }
        throw new Error(message)
      }
      return data as T
    } catch (err) {
      controller.abort()
      assertCurrent()
      if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
        throw new Error(
          `rclone ${path} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`
        )
      }
      throw err
    }
  }

  checkConnection(fs: string): Promise<void> {
    return this.call(
      'operations/list',
      {
        fs,
        remote: '',
        opt: { noModTime: true },
        _config: { ConnectTimeout: '15s', Timeout: '30s' }
      },
      { timeoutMs: 35_000 }
    ).then(() => undefined)
  }

  noop(): Promise<Record<string, unknown>> {
    return this.call('rc/noop', {})
  }

  listRemotes(): Promise<string[]> {
    return this.call<{ remotes?: string[] }>('config/listremotes', {}).then((r) => r.remotes ?? [])
  }

  createRemote(
    name: string,
    type: string,
    parameters: Record<string, string>,
    obscure = true
  ): Promise<void> {
    return this.call('config/create', { name, type, parameters, opt: { obscure } }).then(
      () => undefined
    )
  }

  getRemote(name: string): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('config/get', { name })
  }

  deleteRemote(name: string): Promise<void> {
    return this.call('config/delete', { name }).then(() => undefined)
  }

  async cloneRemote(source: string, target: string): Promise<void> {
    const cfg = await this.getRemote(source)
    const { type, ...parameters } = cfg
    await this.createRemote(target, type ?? 'sftp', parameters, false)
  }

  list(fs: string, remote: string): Promise<RcloneListEntry[]> {
    return this.call<{ list?: RcloneListEntry[] }>('operations/list', { fs, remote }).then(
      (r) => r.list ?? []
    )
  }

  async listRecursiveEntries(fs: string, remote: string): Promise<RcloneListEntry[]> {
    const result = await this.call<{ list?: RcloneListEntry[] }>(
      'operations/list',
      {
        fs,
        remote,
        opt: { recurse: true, noModTime: true },
        _config: { ConnectTimeout: '15s', Timeout: '30s' }
      },
      {
        timeoutMs: RECURSIVE_LIST_TIMEOUT_MS,
        maxResponseBytes: MAX_RECURSIVE_LIST_BYTES
      }
    )
    const entries = result.list ?? []
    if (entries.length > MAX_RECURSIVE_LIST_ENTRIES) {
      throw httpError(400, 'Too many entries in one download folder.', 'DOWNLOAD_LIST_TOO_LARGE')
    }
    return entries
  }

  stat(fs: string, remote: string): Promise<RcloneListEntry | null> {
    return this.call<{ item?: RcloneListEntry | null }>('operations/stat', { fs, remote }).then(
      (r) => r.item ?? null
    )
  }

  copyFileAsync(input: {
    srcFs: string
    srcRemote: string
    dstFs: string
    dstRemote: string
    group: string
    config: CopyFileConfig
  }): Promise<RcloneJobHandle> {
    const endpoint = this.supervisor.getEndpoint()
    return this.call<{ jobid: number; executeId?: string }>(
      'operations/copyfile',
      {
        srcFs: input.srcFs,
        srcRemote: input.srcRemote,
        dstFs: input.dstFs,
        dstRemote: input.dstRemote,
        _async: true,
        _group: input.group,
        _config: input.config
      },
      { endpoint }
    ).then((result) => ({ id: result.jobid, executeId: result.executeId, endpoint }))
  }

  async jobStatus(job: RcloneJobHandle): Promise<RcloneJobStatus> {
    const status = await this.call<RcloneJobStatus>(
      'job/status',
      { jobid: job.id },
      { endpoint: job.endpoint, timeoutMs: 10_000 }
    )
    if (
      status.id !== job.id ||
      (job.executeId && status.executeId && status.executeId !== job.executeId)
    ) {
      throw new RcloneJobLostError()
    }
    return status
  }

  jobStop(job: RcloneJobHandle): Promise<void> {
    return this.call('job/stop', { jobid: job.id }, { endpoint: job.endpoint }).then(
      () => undefined
    )
  }

  coreStats(group: string, job?: RcloneJobHandle): Promise<RcloneStats> {
    return this.call<RcloneStats>(
      'core/stats',
      { group },
      {
        endpoint: job?.endpoint,
        timeoutMs: 10_000
      }
    )
  }

  coreStatsDelete(group: string): Promise<void> {
    return this.call('core/stats-delete', { group }).then(() => undefined)
  }
}
