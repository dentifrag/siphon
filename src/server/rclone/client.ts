import type { RcloneSupervisor } from './supervisor'
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
}

export type CopyFileConfig = MultiThreadConfig

export class RcloneClient {
  constructor(private readonly supervisor: RcloneSupervisor) {}

  private async call<T>(
    path: string,
    body: Record<string, unknown>,
    options: { timeoutMs?: number; maxResponseBytes?: number } = {}
  ): Promise<T> {
    const { baseUrl, authHeader } = this.supervisor.getEndpoint()
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
      const data = text ? JSON.parse(text) : {}
      if (!res.ok) {
        const message = (data && (data.error as string)) || `rclone ${path} failed (${res.status})`
        throw new Error(message)
      }
      return data as T
    } catch (err) {
      controller.abort()
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
  }): Promise<number> {
    return this.call<{ jobid: number }>('operations/copyfile', {
      srcFs: input.srcFs,
      srcRemote: input.srcRemote,
      dstFs: input.dstFs,
      dstRemote: input.dstRemote,
      _async: true,
      _group: input.group,
      _config: input.config
    }).then((r) => r.jobid)
  }

  jobStatus(jobid: number): Promise<RcloneJobStatus> {
    return this.call<RcloneJobStatus>('job/status', { jobid })
  }

  jobStop(jobid: number): Promise<void> {
    return this.call('job/stop', { jobid }).then(() => undefined)
  }

  coreStats(group: string): Promise<RcloneStats> {
    return this.call<RcloneStats>('core/stats', { group })
  }

  coreStatsDelete(group: string): Promise<void> {
    return this.call('core/stats-delete', { group }).then(() => undefined)
  }
}
