import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const marker = 'C:\\dsh-src\\.dsh-mom-root'
if (!existsSync(marker)) {
  console.error('desktop package: product overlay is not linked. From the product repo run: powershell -File desktop\\package-windows.ps1')
  process.exit(1)
}
const productRoot = readFileSync(marker, 'utf8').replace(/^\uFEFF/u, '').trim()
const sync = join(productRoot, 'desktop', 'shell-sync.ps1')
if (!existsSync(sync)) {
  console.error(`desktop package: missing ${sync}`)
  process.exit(1)
}
const result = spawnSync('powershell', ['-NoProfile', '-File', sync, '-Mode', 'apply'], { stdio: 'inherit' })
process.exit(result.status === null ? 1 : result.status)
