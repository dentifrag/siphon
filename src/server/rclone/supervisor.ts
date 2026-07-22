import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveRcloneBinary } from './binary'

export interface RcloneEndpoint {
  baseUrl: string
  authHeader: string
}

export class RcloneSupervisor {
  private child: ChildProcess | null = null
  private endpoint: RcloneEndpoint | null = null
  private readonly user = 'app'
  private readonly pass = randomBytes(24).toString('base64url')
  private shuttingDown = false
  private binaryPath = ''

  constructor(
    private readonly dataDir: string,
    private readonly execDir: string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  get configPath(): string {
    return join(this.dataDir, 'rclone.conf')
  }

  getEndpoint(): RcloneEndpoint {
    if (!this.endpoint) throw new Error('rclone is not running yet.')
    return this.endpoint
  }

  async start(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    this.binaryPath = await resolveRcloneBinary(this.dataDir, this.execDir)
    const port = await freePort()
    const addr = `127.0.0.1:${port}`

    this.child = spawn(
      this.binaryPath,
      [
        'rcd',
        '--rc-addr',
        addr,
        '--rc-user',
        this.user,
        '--rc-pass',
        this.pass,
        '--rc-serve=false',
        '--config',
        this.configPath
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    this.child.stderr?.on('data', (buf: Buffer) => {
      const line = buf.toString().trim()
      if (line) this.log(`[rclone] ${line}`)
    })
    this.child.on('exit', (code) => {
      this.endpoint = null
      if (!this.shuttingDown) {
        this.log(`rclone exited (code ${code}); restarting in 1s`)
        setTimeout(() => {
          this.start().catch((err) => this.log(`rclone restart failed: ${String(err)}`))
        }, 1000)
      }
    })

    this.endpoint = {
      baseUrl: `http://${addr}`,
      authHeader: 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64')
    }

    await this.waitUntilReady()
  }

  private async waitUntilReady(): Promise<void> {
    const endpoint = this.endpoint
    if (!endpoint) throw new Error('rclone endpoint not set.')
    const deadline = Date.now() + 20_000
    let lastErr: unknown
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${endpoint.baseUrl}/rc/noop`, {
          method: 'POST',
          headers: { Authorization: endpoint.authHeader, 'Content-Type': 'application/json' },
          body: '{}'
        })
        if (res.ok) return
        lastErr = new Error(`rc/noop returned ${res.status}`)
      } catch (err) {
        lastErr = err
      }
      await delay(150)
    }
    throw new Error(`rclone did not become ready in time: ${String(lastErr)}`)
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    const child = this.child
    this.child = null
    this.endpoint = null
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child), delay(3000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function once(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()))
}
