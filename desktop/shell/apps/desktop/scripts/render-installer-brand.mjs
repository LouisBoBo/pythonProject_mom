import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const outDir = 'C:/dsh-src/apps/desktop/installer/assets'
const name = '江西中软工作助手'
const logoBuf = readFileSync(fileURLToPath(new URL('../renderer/assets/mom-logo.png', import.meta.url)))

async function badge(size, shadow) {
  const logo = await sharp(logoBuf).resize(size, size).png().toBuffer()
  const pad = shadow ? Math.round(size * 0.15) : 0
  const canvas = size + pad * 2
  const rx = Math.round(size * 0.22)
  const layers = [{
    input: Buffer.from(`<svg width="${canvas}" height="${canvas}" xmlns="http://www.w3.org/2000/svg"><defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${Math.max(1, Math.round(2 * size / 96))}" stdDeviation="${Math.max(1, Math.round(4 * size / 96))}" flood-color="#000" flood-opacity="0.12"/></filter></defs><rect x="${pad}" y="${pad}" width="${size}" height="${size}" rx="${rx}" fill="#FFFFFF"${shadow ? ' filter="url(#f)"' : ''}/></svg>`),
  }]
  const mask = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${rx}" fill="#fff"/></svg>`)
  const rounded = await sharp(logo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
  layers.push({ input: rounded, top: pad, left: pad })
  const buf = await sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers).png().toBuffer()
  return { buffer: buf, size: canvas }
}

async function brand({ width, height, scale, text }) {
  const b = await badge(Math.round(96 * scale), true)
  const fontSize = Math.round(28 * scale)
  const textSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(48 * scale)}">
  <text x="50%" y="70%" text-anchor="middle" fill="${text}"
    font-family="Microsoft YaHei UI, PingFang SC, sans-serif"
    font-size="${fontSize}" font-weight="600">${name}</text>
</svg>`)
  const textPng = await sharp(textSvg).png().toBuffer()
  const gap = Math.round(18 * scale)
  const totalH = b.size + gap + Math.round(48 * scale)
  const top = Math.round((height - totalH) / 2)
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: b.buffer, top, left: Math.round((width - b.size) / 2) },
      { input: textPng, top: top + b.size + gap, left: 0 },
    ])
    .png()
    .toBuffer()
}

async function sidebar({ width, height, dark }) {
  const scale = width / 164
  const b = await badge(Math.round(96 * scale * 1.1), false)
  const fontSize = Math.round(14 * scale)
  const fill = dark ? '#F9FAFB' : '#0F1115'
  const textSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(80 * scale)}">
  <text x="50%" y="40%" text-anchor="middle" fill="${fill}"
    font-family="Microsoft YaHei UI, PingFang SC, sans-serif"
    font-size="${fontSize}" font-weight="600">江西中软</text>
  <text x="50%" y="75%" text-anchor="middle" fill="${fill}"
    font-family="Microsoft YaHei UI, PingFang SC, sans-serif"
    font-size="${fontSize}" font-weight="600">工作助手</text>
</svg>`)
  const textPng = await sharp(textSvg).png().toBuffer()
  const top = Math.round(height * 0.28)
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: dark ? { r: 21, g: 21, b: 23, alpha: 1 } : { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: b.buffer, top, left: Math.round((width - b.size) / 2) },
      { input: textPng, top: top + b.size + Math.round(16 * scale), left: 0 },
    ])
    .png()
    .toBuffer()
}

const jobs = [
  ['brand.png', await brand({
    width: 600, height: 196, scale: 1, text: '#0F1115',
  })],
  ['brand-2x.png', await brand({
    width: 1200, height: 392, scale: 2, text: '#0F1115',
  })],
  ['brand-dark.png', await brand({
    width: 600, height: 196, scale: 1, text: '#F9FAFB',
  })],
  ['brand-dark-2x.png', await brand({
    width: 1200, height: 392, scale: 2, text: '#F9FAFB',
  })],
  ['uninstaller-sidebar.png', await sidebar({ width: 164, height: 314, dark: false })],
]

for (const [file, buffer] of jobs) {
  writeFileSync(join(outDir, file), buffer)
  console.log('wrote', file, buffer.length)
}
