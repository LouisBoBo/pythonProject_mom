import { writeFileSync } from 'node:fs'
import sharp from 'sharp'

const resources = 'C:/dsh-src/apps/desktop/resources'
const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#FFFFFF"/>
  <g fill="none" stroke-linecap="butt" stroke-linejoin="round">
    <path d="M40.5 11.5 C 22 11.5 11.5 22 11.5 32 S 22 52.5 40.5 52.5" stroke="#E31C24" stroke-width="12"/>
    <path d="M41 18.5 C 47.5 18.5 52.5 24.5 52.5 32 S 47.5 45.5 41 45.5" stroke="#0F1115" stroke-width="11"/>
  </g>
  <circle cx="45.5" cy="12" r="5.5" fill="#0F1115"/>
</svg>`)

const png = await sharp(svg).png().toBuffer()
for (const name of ['icon.png', 'icon-windows.png', 'icon-macos.png']) {
  writeFileSync(`${resources}/${name}`, png)
  console.log('wrote', name, png.length)
}
