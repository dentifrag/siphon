import type { ServerConfig } from './config'
import { RcloneSupervisor } from './rclone/supervisor'
import { RcloneClient } from './rclone/client'
import { RcloneDownloadManager } from './rclone/downloadManager'
import { RemoteStore } from './rclone/remotes'

export interface Services {
  supervisor: RcloneSupervisor
  client: RcloneClient
  manager: RcloneDownloadManager
  remotes: RemoteStore
}

export async function createServices(
  config: ServerConfig,
  execDir: string,
  log: (message: string) => void
): Promise<Services> {
  const supervisor = new RcloneSupervisor(config.dataDir, execDir, log)
  await supervisor.start()
  const client = new RcloneClient(supervisor)
  const manager = new RcloneDownloadManager(client)
  const remotes = new RemoteStore(config.dataDir, client)
  return { supervisor, client, manager, remotes }
}
