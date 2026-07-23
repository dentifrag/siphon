import type { ServerConfig } from './config'
import type { AuthService } from './auth'
import type { LoginLimiter } from './loginLimiter'
import type { Services } from './services'
import type { ConnectionSession } from './session'

export interface RouteContext {
  config: ServerConfig
  auth: AuthService
  limiter: LoginLimiter
  services: Services
  session: ConnectionSession
  execDir: string
}
