#!/usr/bin/env node
/**
 * Write the MOM release feed and publish it beside the installer.
 *
 * The feed is read by the desktop shell's company updater. Packaging calls this
 * after every successful build, so "packaged" and "published" stay one step.
 * The feed directory is dedicated to this installer; never point it at the
 * WorkBuddy `/workbuddy-desktop/` directory, which serves a different app.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_FEED_BASE = 'https://175.178.238.31:8443/dsh-mom-desktop/'
const DEFAULT_REMOTE_DIR = '/www/wwwroot/dsh-mom-desktop'
const ENV_FILE = join(HERE, 'update-upload.env')
const DEFAULT_KEEP = 2
const DEFAULT_MIN_BYTES = 50 * 1024 * 1024
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REMOTE_DIR_RE = /^\/[A-Za-z0-9._/-]+$/

function log(message) {
  console.log(`\u001B[1;34m[mom-update-feed]\u001B[0m ${message}`)
}

function die(message) {
  console.error(`\u001B[1;31m[mom-update-feed]\u001B[0m ${message}`)
  process.exit(1)
}

/** Minimal KEY=VALUE reader; existing process values win. */
function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/u, '$2')
    if (key !== '' && process.env[key] === undefined) process.env[key] = value
  }
}

function parseArgs(argv) {
  const options = {
    platform: '',
    version: '',
    artifact: '',
    out: join(HERE, '..', 'dist'),
    notes: process.env.ZR_MOM_UPDATE_NOTES || process.env.WORKBUDDY_UPDATE_NOTES || '详见发版说明。',
    skipUpload: false,
    feedBase: process.env.ZR_MOM_UPDATE_FEED_BASE || process.env.WORKBUDDY_UPDATE_FEED_BASE || DEFAULT_FEED_BASE,
    remoteDir: process.env.WORKBUDDY_DESKTOP_REMOTE_DIR || DEFAULT_REMOTE_DIR,
    keep: Number(process.env.WORKBUDDY_DESKTOP_KEEP || DEFAULT_KEEP),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) die(`${flag} 缺少取值`)
      index += 1
      return next
    }
    switch (flag) {
      case '--platform': options.platform = value(); break
      case '--version': options.version = value(); break
      case '--artifact': options.artifact = value(); break
      case '--out': options.out = value(); break
      case '--notes': options.notes = value(); break
      case '--feed-base': options.feedBase = value(); break
      case '--remote-dir': options.remoteDir = value(); break
      case '--keep': options.keep = Number(value()); break
      case '--skip-upload': options.skipUpload = true; break
      default: die(`未知参数: ${flag}`)
    }
  }
  return options
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', rejectHash)
  })
}

/** Product version baked into the shell overlay; a feed at this version reaches no installed app. */
function productVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'shell', 'apps', 'desktop', 'package.json'), 'utf8')).version
  } catch {
    return ''
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) die(`${label} 无法启动: ${result.error.message}`)
  if (result.status !== 0) die(`${label} 失败（退出码 ${String(result.status)}）`)
}

function capture(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) die(`${label} 无法启动: ${result.error.message}`)
  if (result.status !== 0) die(`${label} 失败（退出码 ${String(result.status)}）\n${result.stderr || ''}`)
  return result.stdout
}

function validateRemoteDir(remote) {
  const normalized = String(remote || '').trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (!normalized.startsWith('/') || normalized.includes('..') || !REMOTE_DIR_RE.test(normalized)) {
    die(`远端目录不合法: ${remote}`)
  }
  return normalized
}

function sshOptions(key, port) {
  return ['-i', key, '-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15']
}

function scpOptions(key, port) {
  return ['-i', key, '-P', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15']
}

function prune(remote, platform, keep, sshArgs) {
  const extension = platform === 'macos' ? '.zip' : '.exe'
  const listing = capture('ssh', [...sshArgs, `cd '${remote}' && ls -1t`], '远端列目录')
    .split(/\r?\n/u).map(name => name.trim()).filter(name => name !== '')
  const installers = listing.filter(name => name.startsWith('zr-dsh-')
    && name.endsWith(extension) && FILE_RE.test(name))
  const doomed = installers.slice(keep)
  if (doomed.length === 0) return
  const command = doomed.map(name => `rm -f -- '${name}'`).join(' && ')
  run('ssh', [...sshArgs, `cd '${remote}' && ${command}`], '清理旧安装包')
  for (const name of doomed) log(`已删除旧安装包: ${name}`)
}

/**
 * Confirm the published feed answers on the server itself.
 *
 * The gateway certificate chains to the company CA, which this machine does not
 * trust, so the probe runs over SSH and uses `curl -k` on the host. Reachability
 * from the public hostname is what matters here, not certificate validation.
 */
function probe(feedBase, platform, sshArgs) {
  const base = String(feedBase || DEFAULT_FEED_BASE)
  const url = new URL(`latest-${platform}.json`, base.endsWith('/') ? base : `${base}/`).toString()
  const status = capture('ssh', [...sshArgs,
    `curl -sk --max-time 10 -o /dev/null -w '%{http_code}' '${url}'`], '探测线上清单').trim()
  if (status !== '200') die(`线上清单返回 HTTP ${status}: ${url}`)
  log(`线上清单可达: ${url}`)
}

async function main() {
  loadEnvFile(ENV_FILE)
  const options = parseArgs(process.argv.slice(2))
  if (options.platform !== 'windows' && options.platform !== 'macos') {
    die('--platform 必须是 windows 或 macos')
  }
  if (!VERSION_RE.test(options.version)) die(`版本号不合法: ${options.version}`)
  const artifact = resolve(options.artifact)
  if (!existsSync(artifact) || !statSync(artifact).isFile()) die(`安装包不存在: ${artifact}`)
  const file = basename(artifact)
  if (!FILE_RE.test(file)) die(`安装包文件名含不安全字符: ${file}`)
  const size = statSync(artifact).size
  const minBytes = Number(process.env.WORKBUDDY_UPDATE_MIN_BYTES || DEFAULT_MIN_BYTES)
  if (!Number.isFinite(size) || size < minBytes) {
    die(`安装包异常过小，拒绝写清单: ${file} = ${size} bytes（阈值 ${minBytes}；可能是打包被中断留下的空壳）`)
  }
  const sha256 = await sha256File(artifact)
  const payload = {
    product: 'MOM',
    platform: options.platform,
    version: options.version.replace(/^v/u, ''),
    publishedAt: new Date().toISOString().slice(0, 10),
    notes: options.notes,
    artifact: { file, sha256, size },
  }
  const outDirectory = resolve(options.out)
  mkdirSync(outDirectory, { recursive: true })
  const feedPath = join(outDirectory, `latest-${options.platform}.json`)
  writeFileSync(feedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  log(`更新清单: ${feedPath}`)
  if (payload.version === productVersion()) {
    log('提示：清单版本等于产品版本，已装同版本的客户端不会收到更新。'
      + '发新版请设置 DSH_DESKTOP_BUILD_VERSION（例如 0.2.1-rc.2.20261102.1）后再打包。')
  }

  const skipUpload = options.skipUpload || process.env.WORKBUDDY_DESKTOP_SKIP_UPLOAD === '1'
  if (skipUpload) {
    log('已跳过上传（--skip-upload / WORKBUDDY_DESKTOP_SKIP_UPLOAD=1）；本次发版尚未上线')
    return
  }
  const key = process.env.WORKBUDDY_DESKTOP_SSH_KEY
  if (key === undefined || key.trim() === '') {
    die(`缺少 WORKBUDDY_DESKTOP_SSH_KEY；请配置 ${ENV_FILE}（模板见 update-upload.env.example）`)
  }
  if (!existsSync(key)) die(`SSH 私钥不存在: ${key}`)
  const host = process.env.WORKBUDDY_DESKTOP_HOST || '175.178.238.31'
  const user = process.env.WORKBUDDY_DESKTOP_USER || 'root'
  const port = Number(process.env.WORKBUDDY_DESKTOP_PORT || 22)
  const keepValue = Math.trunc(options.keep)
  const keep = Number.isFinite(keepValue) ? Math.max(1, keepValue) : DEFAULT_KEEP
  const remote = validateRemoteDir(options.remoteDir)
  const sshArgs = [...sshOptions(key, port), `${user}@${host}`]
  const scpArgs = [...scpOptions(key, port)]

  run('ssh', [...sshArgs, `mkdir -p '${remote}'`], '创建远端目录')
  run('scp', [...scpArgs, artifact, `${user}@${host}:${remote}/${file}`], '上传安装包')
  run('scp', [...scpArgs, feedPath, `${user}@${host}:${remote}/latest-${options.platform}.json`], '上传更新清单')
  prune(remote, options.platform, keep, sshArgs)
  await probe(options.feedBase, options.platform, sshArgs)
  log(`已发布 ${file}（${payload.version}）到 ${options.feedBase}`)
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error))
})
