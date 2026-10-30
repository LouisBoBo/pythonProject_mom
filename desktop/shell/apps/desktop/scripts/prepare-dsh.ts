/** Materialize the complete production runtime before publishing Desktop resources.
 *
 * MOM OVERLAY: This file overrides the upstream BuildRoot prepare-dsh.ts to also
 * copy plugin + SDK packages that exist in the BuildRoot root node_modules but
 * are NOT in the pre-packaged package-set tarballs. Specifically:
 *   - @cursor/sdk + @cursor/sdk-darwin-x64   (Cursor Local Agent npm SDK)
 *   - @zhongruan/dsh-cursor-chat             (DSH Cordis plugin)
 *
 * These are installed by mom's package-macos.sh into BuildRoot root node_modules
 * BEFORE the packaging pipeline runs. Upstream's prepare-dsh.ts rebuilds the
 * runtime from scratch in a temp dir using only package-set tarballs, so our
 * external packages get lost. We copy them in after runtime:materialize-modules.
 */

import { resolveMacOSSignatureCacheDirectory } from './macos-signature-cache-directory.mjs'
import { packagingStep } from './packaging-step.mjs'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { prepareRuntimeManifests } from './prepare-runtime-manifests.ts'
import { prepareRuntimePatches, verifyRuntimePatches } from './prepare-runtime-patches.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
  resolveNpmRegistry,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
// The runtime directory is rebuilt from scratch every run, so a store beside it is what makes a
// second build cheap: pnpm re-resolves metadata but takes tarballs from disk, not the mirror.
const STORE_ROOT = join(BUILD_PATHS.root, 'pnpm-store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const PNPM = join(RUNTIME_ROOT, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')

// --- MOM OVERLAY EXTRA CONFIG ---
// Mom installs external packages (@cursor/*, @zhongruan/*) into the REAL BuildRoot
// node_modules before running the pipeline. We read that path from env.
const MOM_BUILD_ROOT = process.env.MOM_BUILD_ROOT
// Scopes we want to additionally copy from MOM_BUILD_ROOT/node_modules/
const MOM_EXTRA_SCOPES: readonly string[] = ['@cursor', '@zhongruan']

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const registry = resolveNpmRegistry(process.env)
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      '--expose-internals',
      PNPM,
      `--config.registry=${registry}`,
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        ...desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), {}),
        PATH: `${join(RUNTIME_ROOT, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

async function main(): Promise<void> {
  try {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:reset', async () => {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
      rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
      mkdirSync(STORE_ROOT, { recursive: true })
    })
    const release = desktopRelease()
    const patches = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:stage-packages', async () => {
      copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
      cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
      createRuntimeProjectMetadata(BUILD_ROOT, release)
      return prepareRuntimePatches(BUILD_ROOT, resolve(APP_ROOT, '..', '..'))
    })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:lockfile', () => runPnpm(['install', '--lockfile-only']))
    verifyRuntimePatches(BUILD_ROOT, patches)
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:install', () => runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile']))
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: desktopTargetPlatform(targetName).arch }
    const modules = join(BUILD_ROOT, 'node_modules')
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:materialize-modules', async () => {
      cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
        recursive: true, dereference: true,
        filter: source => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
      })
    })

    // ========== MOM OVERLAY BEGIN ==========
    // Copy external packages (@cursor/*, @zhongruan/*) from BuildRoot root node_modules
    // into the prepared dsh runtime. These are installed by mom's package-macos.sh
    // but upstream's prepare-dsh.ts can't see them because it rebuilds runtime from tarballs only.
    //
    // pnpm node_modules uses symlinks: e.g. node_modules/@cursor/sdk -> .pnpm/@cursor+sdk@1.0.31/...
    // We MUST resolve each sub-package to its real path first, then cpSync that real directory.
    // cpSync with dereference:true on the scope directory itself does NOT follow into
    // pnpm-style nested symlinks reliably.
    if (MOM_BUILD_ROOT) {
      for (const scope of MOM_EXTRA_SCOPES) {
        const scopeDir = join(MOM_BUILD_ROOT, 'node_modules', scope)
        if (!existsSync(scopeDir)) {
          console.warn(`[mom-overlay] ${scope} not found in BuildRoot node_modules, skipping`)
          continue
        }
        const targetScopeDir = join(DSH_OUTPUT_ROOT, 'node_modules', scope)
        mkdirSync(targetScopeDir, { recursive: true })
        // For each sub-package in the scope, resolve symlink → realpath → cpSync
        for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
          if (entry.name === '.' || entry.name === '..') continue
          const entryPath = join(scopeDir, entry.name)
          let realPath = entryPath
          if (entry.isSymbolicLink()) {
            try { realPath = realpathSync(entryPath) } catch {
              console.warn(`[mom-overlay] ${scope}/${entry.name}: symlink broken, skipping`)
              continue
            }
          }
          if (!existsSync(realPath)) {
            console.warn(`[mom-overlay] ${scope}/${entry.name}: target missing at ${realPath}, skipping`)
            continue
          }
          const destPath = join(targetScopeDir, entry.name)
          if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true })
          cpSync(realPath, destPath, { recursive: true, force: true })
          console.log(`[mom-overlay] copied ${scope}/${entry.name} (from ${realPath}) → dsh runtime`)
        }
      }
    } else {
      console.info('[mom-overlay] MOM_BUILD_ROOT not set, skipping extra package copy')
    }
    // ========== MOM OVERLAY END ==========

    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    if (process.platform === 'darwin' && process.env.DSH_DESKTOP_UNSIGNED !== '1') {
      const cacheDirectory = resolveMacOSSignatureCacheDirectory(process.env, BUILD_PATHS.root)
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:dsh-native', () => signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:primary-native', () => signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory, 'primary'))
    }
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:primary-smoke', async () => smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime')))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:write-descriptor', async () => writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target))
    const descriptor = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-before-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    if (!process.argv.includes('--defer-runtime-smoke')) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:smoke', () => smokePreparedRuntime(DSH_OUTPUT_ROOT, NODE, RUNTIME_ROOT, descriptor))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-after-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    }
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    let cleaned = false
    const cleanup = (): void => {
      try { rmSync(BUILD_ROOT, { recursive: true, force: true }) }
      finally { rmSync(PNPM_BUILD_STATE, { recursive: true, force: true }) }
      cleaned = true
    }
    try { await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:cleanup', async () => cleanup()) }
    finally { if (!cleaned) cleanup() }
  }
}

await main()
