import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const resources = 'C:/dsh-src/apps/desktop/resources'
const logo = readFileSync(fileURLToPath(new URL('../renderer/assets/mom-logo.png', import.meta.url)))
const mask = Buffer.from(`<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" rx="224" fill="#fff"/></svg>`)

const png = await sharp(logo).resize(1024, 1024).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
for (const name of ['icon.png', 'icon-windows.png', 'icon-macos.png']) {
  writeFileSync(join(resources, name), png)
  console.log('wrote', name, png.length)
}
