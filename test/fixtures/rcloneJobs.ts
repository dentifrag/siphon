import type { RcloneJobHandle } from '../../src/server/rclone/client'

const endpoint = { baseUrl: 'http://127.0.0.1:5572', authHeader: 'Basic test' }

export function jobHandle(id: number): RcloneJobHandle {
  return { id, endpoint }
}
