'use strict'

const path = require('node:path')

const SERVICE_NAME = 'Siphon'
const root = path.resolve(__dirname, '..')

if (process.platform !== 'win32') {
  console.error('[uninstall] This only runs on Windows.')
  process.exit(1)
}

let Service
try {
  ;({ Service } = require('node-windows'))
} catch {
  console.error('[uninstall] node-windows is not installed. Run:  npm install node-windows')
  process.exit(1)
}

const svc = new Service({
  name: SERVICE_NAME,
  script: path.join(root, 'dist-server', 'index.cjs')
})

svc.on('uninstall', () => {
  console.log(`[uninstall] Service "${SERVICE_NAME}" removed.`)
})
svc.on('error', (err) => {
  console.error(`[uninstall] ${err && err.message ? err.message : err}`)
  process.exit(1)
})

console.log(`[uninstall] Removing "${SERVICE_NAME}" (requires Administrator)…`)
svc.uninstall()
