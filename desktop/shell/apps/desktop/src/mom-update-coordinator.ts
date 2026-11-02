/**
 * Update coordinator backed by the company-hosted MOM feed.
 *
 * It reproduces the observable contract of the upstream coordinator (check,
 * download, install, state) so the existing settings indicator, application
 * menu, confirmation dialogs, task locking, and journal keep working. Only the
 * transport and the unsigned-macOS handoff differ.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import * as http from 'node:http'
import type { IncomingMessage } from 'node:http'
import * as https from 'node:https'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog, shell } from 'electron'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import {
  DOWNLOAD_TIMEOUT_MS,
  FEED_TIMEOUT_MS,
  MAX_FEED_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_REDIRECTS,
  feedNameForPlatform,
  isMissingOrUnreachable,
  isNewerVersion,
  momUpdateFeedBase,
  resolveArtifactUrl,
  validateLatest,
  type MomLatestRelease,
} from './mom-update-feed.ts'

const execFileAsync = promisify(execFile)
const UPDATE_DIRECTORY = 'dsh-mom-update'

interface OpenStream {
  readonly response: IncomingMessage
  readonly url: URL
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function updateRoot(): string {
  return join(app.getPath('temp'), UPDATE_DIRECTORY)
}

function safeSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_')
}

/** GET with a bounded redirect chain that may not leave the feed host. */
function openStream(input: string, timeout: number, redirectsLeft: number): Promise<OpenStream> {
  return new Promise((resolveStream, rejectStream) => {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      rejectStream(new Error('地址不合法'))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      rejectStream(new Error('仅支持 http/https'))
      return
    }
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.get(url, { timeout }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume()
        if (redirectsLeft <= 0) {
          rejectStream(new Error('重定向次数过多'))
          return
        }
        let next: URL
        try {
          next = new URL(response.headers.location, url)
        } catch {
          rejectStream(new Error('重定向地址不合法'))
          return
        }
        if (next.host !== url.host) {
          rejectStream(new Error('重定向到其它服务器，已拒绝'))
          return
        }
        openStream(next.toString(), timeout, redirectsLeft - 1).then(resolveStream, rejectStream)
        return
      }
      if (status !== 200) {
        response.resume()
        rejectStream(new Error(`HTTP ${status}`))
        return
      }
      resolveStream({ response, url })
    })
    request.on('timeout', () => { request.destroy(new Error('请求超时')) })
    request.on('error', rejectStream)
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const { response } = await openStream(url, FEED_TIMEOUT_MS, MAX_REDIRECTS)
  return new Promise((resolveJson, rejectJson) => {
    const chunks: Buffer[] = []
    let total = 0
    response.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_FEED_BYTES) {
        response.destroy(new Error('清单过大'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      try {
        resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '')))
      } catch {
        rejectJson(new Error('清单不是合法 JSON'))
      }
    })
    response.on('error', rejectJson)
  })
}

async function fetchLatest(base: string, platform: string): Promise<MomLatestRelease> {
  const name = feedNameForPlatform(platform)
  if (name === '') throw new Error('当前平台不支持在线升级')
  const raw = await fetchJson(new URL(name, base).toString())
  const latest = validateLatest(raw, platform)
  if (latest === undefined) throw new Error('更新清单格式异常')
  return latest
}

/** Stream one installer to disk, emitting throttled progress. */
async function downloadFile(
  url: string,
  destination: string,
  expectedSize: number,
  onProgress: ((received: number, total: number) => void) | undefined,
): Promise<void> {
  const { response } = await openStream(url, DOWNLOAD_TIMEOUT_MS, MAX_REDIRECTS)
  await rm(destination, { force: true }).catch(() => undefined)
  const total = Number(response.headers['content-length'] ?? expectedSize ?? 0)
  await new Promise<void>((resolveDownload, rejectDownload) => {
    let received = 0
    let lastEmit = 0
    let settled = false
    const output = createWriteStream(destination)
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      output.destroy()
      rmSync(destination, { force: true })
      rejectDownload(error)
    }
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_PACKAGE_BYTES) {
        response.destroy(new Error('安装包超过大小上限'))
        return
      }
      const now = Date.now()
      if (onProgress !== undefined && now - lastEmit > 200) {
        lastEmit = now
        onProgress(received, total)
      }
    })
    response.on('error', fail)
    output.on('error', fail)
    output.on('finish', () => {
      if (settled) return
      settled = true
      onProgress?.(received, total > 0 ? total : received)
      resolveDownload()
    })
    response.pipe(output)
  })
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => { hash.update(chunk) })
    stream.on('end', () => { resolveHash(hash.digest('hex')) })
    stream.on('error', rejectHash)
  })
}

/** Company feed coordinator with the same public surface as the upstream one. */
export class DesktopMomUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private candidate: MomLatestRelease | undefined
  private artifactUrl = ''
  private filePath = ''
  private downloaded = false
  private disposed = false
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  /**
   * @param publish - Receives every observable state.
   * @param beforeRestart - Stops tasks and the Host after the user confirms installation.
   * @param downloadResult - Once per completed download attempt.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<boolean>,
    private readonly downloadResult?: (success: boolean, reason?: string) => void,
  ) {}

  get state(): DesktopUpdateState {
    return this.current
  }

  /** Check the company feed without downloading. */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloadOperation !== undefined || this.installOperation !== undefined || this.downloaded) return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    if (manual) this.setState({ phase: 'checking' })
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    // Automatic checks fail silently; a manual check keeps the reason visible.
    if (manual && result.phase === 'error') this.setState(result)
    return result
  }

  /** Download the version the user confirmed, then verify its sha256. */
  async download(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloaded || this.installOperation !== undefined) return this.current
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      this.assertLive()
      const release = this.candidate
      if (release === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== release.version) throw new Error('desktop update: download confirmation is stale')
      const destination = join(updateRoot(), safeSegment(release.version), release.artifact.file)
      mkdirSync(join(updateRoot(), safeSegment(release.version)), { recursive: true })
      this.setState({ phase: 'downloading', version, percent: 0 })
      try {
        await downloadFile(this.artifactUrl, destination, release.artifact.size, (received, total) => {
          if (this.downloaded || this.disposed) return
          const percent = total > 0 ? Math.min(100, Math.round((received * 100) / total)) : 0
          this.setState({ phase: 'downloading', version, percent })
        })
        this.setState({ phase: 'verifying', version, percent: 100 })
        const digest = await sha256File(destination)
        if (digest !== release.artifact.sha256) {
          rmSync(destination, { force: true })
          throw new Error('安装包校验失败（sha256 不符），已删除。请重试或向管理员索取安装包。')
        }
        this.downloaded = true
        this.filePath = destination
        this.downloadResult?.(true)
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        this.downloaded = false
        this.filePath = ''
        try { rmSync(destination, { force: true }) } catch { /* best effort */ }
        this.downloadResult?.(false, 'download_failed')
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /** Hand the verified installer to the platform after the user confirms. */
  async install(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (!this.downloaded || this.filePath === '' || version !== this.candidate?.version) {
      throw new Error('desktop update: confirmed target is not ready')
    }
    this.installOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'installing', version })
      try {
        if (!await this.beforeRestart()) return this.setState({ phase: 'ready', version })
        this.assertLive()
        await this.launchInstaller()
        return this.current
      } catch (error) {
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Stop publishing into closed windows; pending work is abandoned on quit. */
  dispose(): void {
    this.disposed = true
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    return {
      phase: 'error',
      ...this.candidate === undefined ? {} : { version: this.candidate.version },
      failedOperation,
      message: errorMessage(error),
      ...error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails },
      } : {},
    }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    // A development checkout has no installed release to replace.
    if (!app.isPackaged) return this.setState({ phase: 'idle' })
    const base = momUpdateFeedBase()
    if (base === undefined) return this.setState({ phase: 'idle' })
    try {
      const latest = await fetchLatest(base, process.platform)
      const currentVersion = app.getVersion()
      if (!isNewerVersion(latest.version, currentVersion)) {
        this.candidate = undefined
        this.artifactUrl = ''
        this.filePath = ''
        this.downloaded = false
        return this.setState({ phase: 'idle' })
      }
      const url = resolveArtifactUrl(base, latest.artifact.file)
      if (url === '') throw new Error('更新清单异常：安装包地址不合法。请向管理员索取新安装包覆盖安装。')
      this.candidate = latest
      this.artifactUrl = url
      this.filePath = ''
      this.downloaded = false
      return this.setState({ phase: 'available', version: latest.version })
    } catch (error) {
      const message = errorMessage(error)
      this.candidate = undefined
      this.artifactUrl = ''
      // The product treats a missing feed or an offline server as "already current".
      if (isMissingOrUnreachable(message)) return this.setState({ phase: 'idle' })
      return this.failure(error, 'check')
    }
  }

  private async launchInstaller(): Promise<void> {
    const root = resolve(updateRoot())
    const file = resolve(this.filePath)
    if (file === root || !file.startsWith(`${root}${sep}`)) {
      throw new Error('安装包路径异常，已拒绝执行。')
    }
    if (!existsSync(file)) throw new Error('安装包已不存在，请重新下载。')
    if (process.platform === 'win32') {
      if (!/\.exe$/i.test(file)) throw new Error('安装包类型异常（需要 .exe）。')
      // The installer is a GUI program and must outlive this application.
      const child = spawn(file, [], { detached: true, stdio: 'ignore' })
      child.unref()
      setTimeout(() => { app.quit() }, 500)
      return
    }
    if (process.platform === 'darwin') {
      if (!/\.zip$/i.test(file)) throw new Error('安装包类型异常（需要 .zip）。')
      const extractDirectory = join(updateRoot(), safeSegment(this.candidate?.version ?? 'unknown'), 'extracted')
      rmSync(extractDirectory, { recursive: true, force: true })
      mkdirSync(extractDirectory, { recursive: true })
      await execFileAsync('ditto', ['-xk', file, extractDirectory], { timeout: 300_000 })
      const bundle = readdirSync(extractDirectory)
        .find(name => name.endsWith('.app') && statSync(join(extractDirectory, name)).isDirectory())
      if (bundle === undefined) throw new Error('解压结果异常：未找到应用程序。请向管理员索取安装包。')
      const appPath = join(extractDirectory, bundle)
      shell.showItemInFolder(appPath)
      await dialog.showMessageBox({
        type: 'info',
        title: app.getName(),
        message: '新版本已解压',
        detail: `已在 Finder 中选中新版 ${bundle}。\n\n点「退出并替换」后，把新版拖进「应用程序」替换旧版即可（首次打开请右键 → 打开）。`,
        buttons: ['退出并替换'],
        defaultId: 0,
      })
      app.quit()
      return
    }
    throw new Error('当前平台暂不支持应用内升级，请向管理员索取新安装包。')
  }
}
