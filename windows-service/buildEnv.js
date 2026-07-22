'use strict'

const path = require('node:path')

function buildServiceEnv(cfg, root) {
  const dataDir = cfg.dataDir || path.join(root, 'data')
  const env = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'PORT', value: String(cfg.port || 8080) },
    { name: 'HOST', value: cfg.host || '0.0.0.0' },
    { name: 'DATA_DIR', value: dataDir }
  ]
  if (cfg.downloadDirs) env.push({ name: 'DOWNLOAD_DIRS', value: cfg.downloadDirs })
  if (cfg.appPassword) env.push({ name: 'APP_PASSWORD', value: cfg.appPassword })
  return env
}

module.exports = { buildServiceEnv }
