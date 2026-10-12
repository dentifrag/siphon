import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateCapability, UpdateJob, UpdateStatus } from '../shared/api'
import type { TransferProgress } from '../shared/types'
import { httpError } from './http'

const latestUrl = 'https://api.github.com/repos/dentifrag/siphon/releases/latest'
const assetName = 'siphon-win-x64.exe'
const manifestName = 'siphon-win-x64.update.json'
const runFile = promisify(execFile)
const terminalPhases = new Set(['succeeded', 'rolled-back', 'failed'])

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Windows update metadata.')
  }
  return value as JsonObject
}

function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Only stable numeric release versions are supported.')
  }
  const parts = value.split('.').map(Number)
  if (!parts.every((part) => Number.isSafeInteger(part) && part <= 2147483647)) {
    throw new Error('Invalid release version for the Windows helper.')
  }
  return parts
}

function releaseIdentity(value: unknown, currentVersion: string) {
  const release = object(value)
  const tag = release.tag_name
  if (typeof tag !== 'string') throw new Error('Missing release tag.')
  const version = tag.replace(/^v/, '')
  const next = versionParts(version)
  const current = versionParts(currentVersion)
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    release.html_url !== `https://github.com/dentifrag/siphon/releases/tag/${tag}` ||
    !Number.isSafeInteger(release.id) ||
    Number(release.id) <= 0
  ) {
    throw new Error('The release is not an official published stable Siphon release.')
  }
  let upgrade = false
  for (let i = 0; i < 3; i++) {
    if (next[i] === current[i]) continue
    upgrade = next[i] > current[i]
    break
  }
  return { release, tag, version, upgrade }
}

function releaseAssets(release: JsonObject, tag: string) {
  if (!Array.isArray(release.assets)) throw new Error('Missing Windows update assets.')
  const assets = release.assets.map(object)
  const get = (name: string) => {
    const matches = assets.filter((asset) => asset.name === name)
    if (matches.length !== 1) {
      throw new Error(`Release incompatible: expected exactly one ${name}.`)
    }
    const asset = matches[0]
    if (
      asset.browser_download_url !==
        `https://github.com/dentifrag/siphon/releases/download/${tag}/${name}` ||
      !Number.isSafeInteger(asset.id) ||
      Number(asset.id) <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) <= 0
    ) {
      throw new Error('Invalid official Windows asset identity.')
    }
    return asset
  }
  return { executable: get(assetName), manifest: get(manifestName) }
}

export function validateUpdateRelease(input: {
  release: unknown
  manifest: unknown
  currentVersion: string
}) {
  const { release, tag, version, upgrade } = releaseIdentity(input.release, input.currentVersion)
  if (!upgrade) return null
  const assets = releaseAssets(release, tag)
  const manifest = object(input.manifest)
  if (
    manifest.protocolVersion !== 1 ||
    manifest.version !== version ||
    manifest.assetName !== assetName ||
    manifest.sizeBytes !== assets.executable.size ||
    Number(manifest.sizeBytes) > 512 * 1024 * 1024 ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error('Release incompatible: Windows update manifest or helper protocol mismatch.')
  }
  const sha256 = manifest.sha256.toLowerCase()
  if (assets.executable.digest && assets.executable.digest !== `sha256:${sha256}`) {
    throw new Error('Release asset digest does not match the update manifest.')
  }
  return {
    version,
    releaseTag: tag,
    protocolVersion: 1 as const,
    assetName,
    assetUrl: String(assets.executable.browser_download_url),
    sizeBytes: Number(manifest.sizeBytes),
    sha256
  }
}

export interface UpdateRequest {
  id: string
  fromVersion: string
  toVersion: string
  releaseTag: string
  protocolVersion: 1
  assetName: string
  assetUrl: string
  sizeBytes: number
  sha256: string
}

export interface UpdateCoordinatorOptions {
  currentVersion: string
  stateDir: string
  capability: UpdateCapability
  listTransfers: () => TransferProgress[]
  fetch: typeof globalThis.fetch
  schedule: (request: UpdateRequest) => Promise<void>
  inspect?: () => Promise<{ capability: UpdateCapability; taskIdle: boolean }>
  protectedPaths?: string[]
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const pending = `${path}.${randomUUID()}.pending`
  await writeFile(pending, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', flush: true })
  await rename(pending, path)
}

function requestFromDisk(value: unknown): UpdateRequest {
  const request = object(value)
  if (
    Object.keys(request).length !== 9 ||
    typeof request.id !== 'string' ||
    !/^[\w-]{1,128}$/.test(request.id) ||
    request.protocolVersion !== 1 ||
    request.assetName !== assetName ||
    typeof request.releaseTag !== 'string' ||
    request.assetUrl !==
      `https://github.com/dentifrag/siphon/releases/download/${request.releaseTag}/${assetName}` ||
    typeof request.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.sha256) ||
    !Number.isSafeInteger(request.sizeBytes) ||
    Number(request.sizeBytes) <= 0 ||
    Number(request.sizeBytes) > 512 * 1024 * 1024
  ) {
    throw new Error('Invalid persisted update request; administrator recovery is required.')
  }
  versionParts(request.fromVersion)
  versionParts(request.toVersion)
  if (request.releaseTag.replace(/^v/, '') !== request.toVersion) {
    throw new Error('Persisted update release identity mismatch.')
  }
  return request as unknown as UpdateRequest
}

async function fetchJson(fetch: typeof globalThis.fetch, url: string, maxBytes: number) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          'Release metadata request timed out after 15 seconds. Check connectivity to GitHub and try again.'
        )
      ),
    15_000
  )
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Siphon-updater/1' }
    })
    if (!response.ok) throw new Error(`Release request failed (${response.status}).`)
    if (Number(response.headers.get('content-length')) > maxBytes) {
      throw new Error('Release metadata exceeds the allowed size.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Release metadata is empty.')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('Release metadata exceeds the allowed size.')
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

export async function createUpdateCoordinator(options: UpdateCoordinatorOptions) {
  const { stateDir, currentVersion } = options
  let capability = options.capability
  let check: UpdateStatus['check'] = { state: 'idle' }
  let checkedOffer:
    | (NonNullable<ReturnType<typeof validateUpdateRelease>> & {
        id: string
        releaseId: unknown
        assetId: unknown
        manifestId: unknown
      })
    | null = null
  let active: UpdateRequest | null = null
  let activeOfferId: string | null = null
  let maintenance = false
  let revision = 0
  let admissions = 0
  let job: UpdateJob | null = null
  let uncertainty: string | null = null
  let checking = false
  let scheduling = false
  const acceptedJob = (request: UpdateRequest): UpdateJob => {
    const now = new Date().toISOString()
    return {
      id: request.id,
      offerId: activeOfferId ?? 'unknown',
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      phase: 'accepted',
      serviceHealth: 'unknown',
      startedAt: now,
      updatedAt: now
    }
  }
  try {
    const stored = await readJson(join(stateDir, 'request.json'))
    if (stored) {
      active = requestFromDisk(stored)
      maintenance = true
      const proof = await readJson(join(stateDir, 'proof.json'))
      if (proof && object(proof).id === active.id && typeof object(proof).offerId === 'string') {
        activeOfferId = String(object(proof).offerId)
      }
      job = acceptedJob(active)
      const scheduling = await readJson(join(stateDir, 'scheduling.json'))
      uncertainty =
        scheduling && object(scheduling).id === active.id
          ? String(object(scheduling).message)
          : 'Accepted update is awaiting worker and task reconciliation.'
    } else {
      const history = await readJson(join(stateDir, 'job.json'))
      if (history) {
        const previous = object(history)
        if (
          typeof previous.id !== 'string' ||
          typeof previous.fromVersion !== 'string' ||
          typeof previous.toVersion !== 'string' ||
          !terminalPhases.has(String(previous.phase)) ||
          previous.serviceHealth !== 'healthy'
        ) {
          throw new Error(
            'An unfinished worker journal has no accepted request; administrator recovery is required.'
          )
        }
        const proof = await readJson(join(stateDir, 'proof.json'))
        job = {
          ...previous,
          offerId:
            proof && object(proof).id === previous.id
              ? String(object(proof).offerId ?? 'unknown')
              : 'unknown'
        } as unknown as UpdateJob
      }
    }
  } catch (error) {
    maintenance = true
    uncertainty = error instanceof Error ? error.message : String(error)
    capability = { supported: false, reason: 'unsafe-install', message: uncertainty }
  }

  const busy = () =>
    admissions > 0 ||
    options.listTransfers().some((transfer) => ['queued', 'downloading'].includes(transfer.status))

  async function status(): Promise<UpdateStatus> {
    const readRevision = revision
    const readRequest = active
    let taskIdle = !options.inspect
    let inspectedCapability = capability
    if (options.inspect) {
      try {
        const inspected = await options.inspect()
        taskIdle = inspected.taskIdle
        inspectedCapability = inspected.capability
      } catch {
        taskIdle = false
        inspectedCapability = {
          supported: false,
          reason: 'unsafe-install',
          message: 'Cannot verify the installed helper or Scheduled Task.'
        }
      }
    }
    let storedJob: UpdateJob | null = null
    let journalError: string | null = null
    if (readRequest) {
      try {
        const stored = await readJson(join(stateDir, 'job.json'))
        if (stored) {
          const entry = object(stored)
          if (
            entry.id === readRequest.id &&
            entry.fromVersion === readRequest.fromVersion &&
            entry.toVersion === readRequest.toVersion &&
            typeof entry.phase === 'string' &&
            typeof entry.startedAt === 'string' &&
            typeof entry.updatedAt === 'string'
          ) {
            storedJob = { ...entry, offerId: activeOfferId ?? 'unknown' } as unknown as UpdateJob
          }
        }
      } catch {
        storedJob = null
        journalError = 'The worker journal is unreadable; administrator recovery may be required.'
      }
    }
    if (revision === readRevision && active === readRequest) {
      capability = inspectedCapability
      if (storedJob) {
        job = storedJob
        if (
          maintenance &&
          !scheduling &&
          taskIdle &&
          inspectedCapability.supported &&
          storedJob.serviceHealth === 'healthy' &&
          terminalPhases.has(storedJob.phase) &&
          (!options.inspect ||
            currentVersion ===
              (storedJob.phase === 'succeeded' ? storedJob.toVersion : storedJob.fromVersion))
        ) {
          maintenance = false
          uncertainty = null
          revision++
        } else if (storedJob.phase !== 'accepted') {
          uncertainty = null
        }
      }
    }
    const blockedReason = maintenance
      ? uncertainty ||
        (revision === readRevision ? journalError : null) ||
        (taskIdle && job?.phase === 'accepted'
          ? 'The accepted task is idle without matching worker progress. Its outcome is unknown; Retry accepted task can reconcile this same request.'
          : 'Update maintenance is active; wait for the worker and task to finish.')
      : !capability.supported
        ? capability.message
        : !taskIdle
          ? 'The update task or installer is still active.'
          : busy()
            ? 'Transfers are active. Finish or cancel queued and running transfers before installing.'
            : undefined
    return {
      currentVersion,
      capability,
      check,
      offer: checkedOffer
        ? {
            id: checkedOffer.id,
            version: checkedOffer.version,
            protocolVersion: 1,
            sizeBytes: checkedOffer.sizeBytes
          }
        : null,
      job,
      maintenance,
      canInstall: Boolean(
        checkedOffer && capability.supported && taskIdle && !maintenance && !busy()
      ),
      ...(blockedReason ? { blockedReason } : {})
    }
  }

  async function checkForUpdates(): Promise<UpdateStatus> {
    if (checking || maintenance) throw httpError(409, 'An update operation is already active.')
    if (!capability.supported) throw httpError(409, capability.message)
    checking = true
    checkedOffer = null
    try {
      if (options.inspect) {
        const inspection = await options.inspect()
        capability = inspection.capability
        if (!capability.supported) throw new Error(capability.message)
      }
      const release = await fetchJson(options.fetch, latestUrl, 2 * 1024 * 1024)
      const identity = releaseIdentity(release, currentVersion)
      if (identity.upgrade) {
        const assets = releaseAssets(identity.release, identity.tag)
        const manifest = await fetchJson(
          options.fetch,
          String(assets.manifest.browser_download_url),
          16 * 1024
        )
        const validated = validateUpdateRelease({ release, manifest, currentVersion })
        if (validated) {
          checkedOffer = {
            ...validated,
            id: randomUUID(),
            releaseId: identity.release.id,
            assetId: assets.executable.id,
            manifestId: assets.manifest.id
          }
        }
      }
      check = { state: 'checked' }
    } catch (error) {
      checkedOffer = null
      check = {
        state: 'error',
        error: error instanceof Error ? error.message : 'Release check failed.'
      }
    } finally {
      checking = false
    }
    return status()
  }

  async function install(offerId: string): Promise<UpdateJob> {
    if (
      maintenance ||
      checking ||
      busy() ||
      !capability.supported ||
      !checkedOffer ||
      checkedOffer.id !== offerId
    ) {
      throw httpError(409, 'Update is unavailable, transfers are active, or the offer is stale.')
    }
    const offer = checkedOffer
    maintenance = true
    scheduling = true
    revision++
    const request: UpdateRequest = Object.freeze({
      id: randomUUID(),
      fromVersion: currentVersion,
      toVersion: offer.version,
      releaseTag: offer.releaseTag,
      protocolVersion: 1,
      assetName: offer.assetName,
      assetUrl: offer.assetUrl,
      sizeBytes: offer.sizeBytes,
      sha256: offer.sha256
    })
    active = request
    activeOfferId = offer.id
    job = acceptedJob(request)
    const result = job
    let persisted = false
    try {
      if (options.inspect) {
        const inspection = await options.inspect()
        if (!inspection.capability.supported || !inspection.taskIdle) {
          throw new Error('Installed helper is unavailable or its task is still running.')
        }
      }
      await atomicJson(join(stateDir, 'proof.json'), {
        id: request.id,
        offerId: offer.id,
        releaseId: offer.releaseId,
        assetId: offer.assetId,
        manifestId: offer.manifestId
      })
      uncertainty = 'Update scheduling outcome is unknown; awaiting worker and task reconciliation.'
      await atomicJson(join(stateDir, 'scheduling.json'), {
        id: request.id,
        message: uncertainty
      })
      await atomicJson(join(stateDir, 'request.json'), request)
      persisted = true
      await options.schedule(request)
      uncertainty = null
    } catch (error) {
      if (!persisted) {
        active = null
        activeOfferId = null
        job = null
        maintenance = false
        uncertainty = null
        revision++
      } else {
        uncertainty = `Scheduled Task outcome is unknown: ${error instanceof Error ? error.message : String(error)}. Use Retry accepted task only after the task is verified idle.`
        await atomicJson(join(stateDir, 'scheduling.json'), {
          id: request.id,
          message: uncertainty
        }).catch(() => undefined)
      }
      throw Object.assign(
        httpError(503, persisted ? uncertainty! : 'Could not persist or accept this update.'),
        { accepted: persisted }
      )
    } finally {
      scheduling = false
      revision++
    }
    return result
  }

  async function retryAcceptedTask(): Promise<UpdateJob> {
    if (!maintenance || !active || !options.inspect || scheduling) {
      throw httpError(409, 'There is no recoverable accepted task.')
    }
    const retryRequest = active
    scheduling = true
    const retryRevision = ++revision
    try {
      const inspection = await options.inspect()
      if (
        !inspection.capability.supported ||
        !inspection.taskIdle ||
        retryRevision !== revision ||
        retryRequest !== active
      ) {
        throw httpError(409, 'The accepted task cannot safely be retried.')
      }
      uncertainty = 'Retry scheduling outcome is unknown; reconciling the same accepted task.'
      await atomicJson(join(stateDir, 'scheduling.json'), {
        id: retryRequest.id,
        message: uncertainty
      })
      await options.schedule(retryRequest)
      return job!
    } finally {
      scheduling = false
      revision++
    }
  }

  return {
    stateDir,
    protectedPaths: [stateDir, ...(options.protectedPaths ?? [])],
    status,
    check: checkForUpdates,
    install,
    retryAcceptedTask,
    admitTransfer() {
      if (maintenance) throw httpError(409, 'Transfers are blocked during update maintenance.')
      admissions++
      let released = false
      return () => {
        if (!released) {
          released = true
          admissions--
        }
      }
    }
  }
}

export type UpdateCoordinator = Awaited<ReturnType<typeof createUpdateCoordinator>>

export async function createInstalledUpdates(input: {
  currentVersion: string
  host: string
  port: number
  listTransfers: () => TransferProgress[]
}): Promise<UpdateCoordinator> {
  const execDir = dirname(process.execPath)
  const stateDir = join(execDir, 'siphon-updater')
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const worker = join(stateDir, 'Update-SiphonService.ps1')
  const inspect = async () => {
    const { stdout } = await runFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', worker, '-Inspect'],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, shell: false }
    )
    const record = object(JSON.parse(stdout))
    if (
      record.protocolVersion !== 1 ||
      record.executablePath !== process.execPath ||
      record.host !== input.host ||
      record.port !== input.port ||
      record.serviceName !== 'Siphon' ||
      record.taskName !== 'SiphonUpdate' ||
      record.serviceRunning !== true
    ) {
      return {
        capability: {
          supported: false,
          reason: 'unsafe-install',
          message: 'The running executable does not match the protected service installation.'
        } as UpdateCapability,
        taskIdle: false
      }
    }
    return {
      capability: { supported: true } as UpdateCapability,
      taskIdle: record.taskIdle === true
    }
  }
  const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
  const installedIdentity =
    process.platform === 'win32' && packaged && process.env.SIPHON_UPDATER_DIR === stateDir
  let capability: UpdateCapability = {
    supported: false,
    reason: 'not-windows-service',
    message: 'Updates require an installed Windows service with the one-time updater setup.'
  }
  if (installedIdentity) {
    try {
      capability = (await inspect()).capability
    } catch {
      capability = {
        supported: false,
        reason: 'setup-required',
        message: 'Rerun the Windows service installer to configure the protected update helper.'
      }
    }
  }
  return createUpdateCoordinator({
    ...input,
    stateDir,
    capability,
    fetch: officialAssetFetch,
    inspect: installedIdentity ? inspect : async () => ({ capability, taskIdle: false }),
    protectedPaths: installedIdentity
      ? [execDir]
      : [
          process.execPath,
          join(execDir, 'siphon-service.exe'),
          join(execDir, 'siphon-service.xml')
        ],
    schedule: async () => {
      await runFile(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'),
        ['/Run', '/TN', '\\SiphonUpdate'],
        { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, shell: false }
      )
    }
  })
}

async function officialAssetFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> {
  let url = String(input)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await globalThis.fetch(url, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('Asset redirect has no location.')
    const next = new URL(location, url)
    if (
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      next.port ||
      next.hash ||
      next.hostname !== 'release-assets.githubusercontent.com' ||
      !next.pathname.startsWith('/github-production-release-asset/')
    ) {
      throw new Error('Asset redirect is outside official GitHub release storage.')
    }
    url = next.href
  }
  throw new Error('Too many official asset redirects.')
}
