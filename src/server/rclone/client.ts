import type { RcloneSupervisor } from './supervisor'

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

export interface CopyFileConfig {
  MultiThreadStreams: number
  MultiThreadCutoff: string
  MultiThreadChunkSize: string
}

export class RcloneClient {
  constructor(private readonly supervisor: RcloneSupervisor) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const { baseUrl, authHeader } = this.supervisor.getEndpoint()
    const res = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const message = (data && (data.error as string)) || `rclone ${path} failed (${res.status})`
      throw new Error(message)
    }
    return data as T
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

  list(fs: string, remote: string): Promise<RcloneListEntry[]> {
    return this.call<{ list?: RcloneListEntry[] }>('operations/list', { fs, remote }).then(
      (r) => r.list ?? []
    )
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
