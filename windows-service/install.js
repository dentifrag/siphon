'use strict'

const path = require('node:path')
const fs = require('node:fs')

const SERVICE_NAME = 'Siphon'
const root = path.resolve(__dirname, '..')

function fail(message) {
  console.error(`\n[install] ${message}\n`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  fail('This installer only runs on Windows. On Linux/Mac use Docker or a systemd service.')
}

const script = path.join(root, 'dist-server', 'index.cjs')
if (!fs.existsSync(script)) {
  fail(
    'Server bundle not found at dist-server/index.cjs.\n' +
      'Build it first:  npm ci  &&  npm run web:build:all'
  )
}

const configPath = path.join(__dirname, 'service.config.json')
if (!fs.existsSync(configPath)) {
  fail(
    'Missing windows-service/service.config.json.\n' +
      'Copy the example and edit it:\n' +
      '  copy windows-service\\service.config.example.json windows-service\\service.config.json'
  )
}

let cfg
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
  fail(`Could not parse service.config.json: ${err.message}`)
}

let Service
try {
  ;({ Service } = require('node-windows'))
} catch {
  fail('node-windows is not installed. Run:  npm install node-windows')
}

const dataDir = cfg.dataDir || path.join(root, 'data')

const { buildServiceEnv } = require('./buildEnv')
const env = buildServiceEnv(cfg, root)

const svc = new Service({
  name: SERVICE_NAME,
  description: 'Siphon: a self-hosted web UI for rclone.',
  script,
  workingDirectory: root,
  env,
  wait: 2,
  grow: 0.5,
  maxRestarts: 20
})

svc.on('install', () => {
  console.log(`[install] Service "${SERVICE_NAME}" installed. Starting…`)
  svc.start()
})
svc.on('alreadyinstalled', () => {
  console.log(`[install] Service "${SERVICE_NAME}" is already installed. Nothing to do.`)
})
svc.on('start', () => {
  const port = cfg.port || 8080
  console.log(
    `[install] Service started. Open http://localhost:${port} (or http://<this-pc-ip>:${port}).\n` +
      '[install] It will now start automatically on boot, no login required.\n' +
      '[install] Manage it in services.msc, or:  net stop Siphon  /  net start Siphon'
  )
})
svc.on('error', (err) => {
  fail(`Service error: ${err && err.message ? err.message : err}`)
})

if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch {}
}

console.log(`[install] Installing "${SERVICE_NAME}" (requires Administrator)…`)
svc.install()
