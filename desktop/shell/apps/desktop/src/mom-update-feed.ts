/**
 * Company-hosted release feed for the MOM desktop installer.
 *
 * The feed is the same contract the WorkBuddy build uses: one JSON document per
 * platform beside the installer, both served from a dedicated directory. It is
 * deliberately separate from `/workbuddy-desktop/` so the two different
 * installers can never be mistaken for one another.
 */

/** Production feed directory; operations may override it for testing. */
export const DEFAULT_MOM_UPDATE_FEED_BASE = 'https://175.178.238.31:8443/dsh-mom-desktop/'

/** Preferred override used by packaging and diagnostics. */
export const MOM_UPDATE_FEED_BASE_ENV = 'ZR_MOM_UPDATE_FEED_BASE'

/** Previous build's variable name, kept so existing operations scripts still work. */
const LEGACY_FEED_BASE_ENV = 'WORKBUDDY_UPDATE_FEED_BASE'

/** Hard ceiling for one installer; the packaged application is roughly 1 GB. */
export const MAX_PACKAGE_BYTES = 3 * 1024 * 1024 * 1024

/** Bounds used while guarding against a hostile or broken feed. */
export const MAX_FEED_BYTES = 1024 * 1024
export const MAX_REDIRECTS = 5
export const FEED_TIMEOUT_MS = 15_000
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/** One validated release document. */
export interface MomLatestRelease {
  readonly version: string
  readonly notes: string
  readonly publishedAt: string
  readonly artifact: {
    readonly file: string
    readonly sha256: string
    readonly size: number
  }
}

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly (string | number)[]
}

/**
 * Resolve the feed root from the environment.
 * @param env - desktop process or packaging environment.
 * @returns normalized root with a trailing slash, or undefined when disabled/invalid.
 */
export function momUpdateFeedBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = String(env[MOM_UPDATE_FEED_BASE_ENV] ?? env[LEGACY_FEED_BASE_ENV] ?? DEFAULT_MOM_UPDATE_FEED_BASE).trim()
  if (raw === '') return undefined
  try {
    const url = new URL(raw.endsWith('/') ? raw : `${raw}/`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** @param platform - Electron process platform. @returns feed document name, or empty when unsupported. */
export function feedNameForPlatform(platform: string): string {
  if (platform === 'win32') return 'latest-windows.json'
  if (platform === 'darwin') return 'latest-macos.json'
  return ''
}

/** @param platform - Electron process platform. @returns platform field stored in the feed. */
export function platformKey(platform: string): string {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return ''
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  for (const field of prerelease) {
    if (field === '') return undefined
    if (/^\d+$/.test(field) && field.length > 1 && field.startsWith('0')) return undefined
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: prerelease.map(field => /^\d+$/.test(field) ? Number(field) : field),
  }
}

/**
 * Compare two semantic versions, including prerelease precedence.
 * @returns negative, zero, or positive when `a` is below, equal to, or above `b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? { core: [0, 0, 0], prerelease: [] }
  const right = parseVersion(b) ?? { core: [0, 0, 0], prerelease: [] }
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  // A release outranks any prerelease of the same core version.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.prerelease[index]
    const y = right.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = typeof x === 'number'
    const yNumeric = typeof y === 'number'
    if (xNumeric && yNumeric) return x < y ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** @returns whether `candidate` is a valid version newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (parseVersion(candidate) === undefined) return false
  return compareVersions(candidate, current) > 0
}

/** Accept only a plain file name; paths, escapes, and encoded separators are rejected. */
export function isSimpleFileName(file: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) && !file.includes('..')
}

/**
 * Build the download URL from the feed root and a validated file name.
 * @returns absolute URL on the feed origin, or an empty string when rejected.
 */
export function resolveArtifactUrl(base: string, file: string): string {
  if (!isSimpleFileName(file)) return ''
  let feed: URL
  try {
    feed = new URL(base)
  } catch {
    return ''
  }
  if (feed.protocol !== 'http:' && feed.protocol !== 'https:') return ''
  let url: URL
  try {
    url = new URL(encodeURIComponent(file), feed)
  } catch {
    return ''
  }
  return url.host === feed.host ? url.toString() : ''
}

/**
 * Validate one feed document. Missing integrity fields fail closed.
 * @param raw - parsed JSON.
 * @param platform - Electron process platform.
 * @returns normalized release, or undefined when the document is unsuitable.
 */
export function validateLatest(raw: unknown, platform: string): MomLatestRelease | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const bag = raw as Record<string, unknown>
  const wanted = platformKey(platform)
  if (wanted === '') return undefined
  if (bag.product !== undefined && String(bag.product).toUpperCase() !== 'MOM') return undefined
  if (bag.platform !== undefined && String(bag.platform) !== wanted) return undefined
  const version = typeof bag.version === 'string' ? bag.version.trim() : ''
  if (parseVersion(version) === undefined) return undefined
  const artifact = bag.artifact
  if (typeof artifact !== 'object' || artifact === null) return undefined
  const fields = artifact as Record<string, unknown>
  const file = typeof fields.file === 'string' ? fields.file.trim() : ''
  const sha256 = typeof fields.sha256 === 'string' ? fields.sha256.trim().toLowerCase() : ''
  const size = Number(fields.size)
  if (!isSimpleFileName(file)) return undefined
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PACKAGE_BYTES) return undefined
  return {
    version,
    notes: typeof bag.notes === 'string' ? bag.notes : '',
    publishedAt: typeof bag.publishedAt === 'string' ? bag.publishedAt : '',
    artifact: { file, sha256, size },
  }
}

/** A missing feed or an unreachable server means "no update", not a broken feed. */
export function isMissingOrUnreachable(message: string): boolean {
  return /^HTTP 404\b/i.test(message)
    || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|请求超时|socket hang up|getaddrinfo/i.test(message)
}
