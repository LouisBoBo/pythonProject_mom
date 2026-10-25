import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const outDir = 'C:/dsh-src/apps/desktop/installer/assets'
const name = '江西中软工作助手'

function logoSvg(size, inner) {
  const s = size / 64
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <g fill="none" stroke-linecap="butt" stroke-linejoin="round" transform="scale(1)">
    <path d="M40.5 11.5 C 22 11.5 11.5 22 11.5 32 S 22 52.5 40.5 52.5" stroke="#E31C24" stroke-width="12"/>
    <path d="M41 18.5 C 47.5 18.5 52.5 24.5 52.5 32 S 47.5 45.5 41 45.5" stroke="${inner}" stroke-width="11"/>
  </g>
  <circle cx="45.5" cy="12" r="5.5" fill="${inner}"/>
</svg>`)
}

async function circleBadge(outer, logoInner, scale) {
  const diameter = Math.round(96 * scale)
  const pad = Math.round(14 * scale)
  const canvas = diameter + pad * 2
  const logo = await sharp(logoSvg(Math.round(56 * scale), logoInner))
    .resize(Math.round(56 * scale), Math.round(56 * scale))
    .png()
    .toBuffer()
  const shadow = await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: Buffer.from(`<svg width="${canvas}" height="${canvas}" xmlns="http://www.w3.org/2000/svg">
        <defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="${2 * scale}" stdDeviation="${4 * scale}" flood-color="#000" flood-opacity="0.12"/>
        </filter></defs>
        <circle cx="${canvas / 2}" cy="${canvas / 2}" r="${diameter / 2}" fill="${outer}" filter="url(#f)"/>
      </svg>`),
      top: 0,
      left: 0,
    }, {
      input: logo,
      top: Math.round((canvas - 56 * scale) / 2),
      left: Math.round((canvas - 56 * scale) / 2),
    }])
    .png()
    .toBuffer()
  return { buffer: shadow, size: canvas }
}

async function brand({ width, height, scale, bg, text, logoInner, circleFill }) {
  const badge = await circleBadge(circleFill, logoInner, scale)
  const fontSize = Math.round(28 * scale)
  const textSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(48 * scale)}">
  <text x="50%" y="70%" text-anchor="middle" fill="${text}"
    font-family="Microsoft YaHei UI, PingFang SC, sans-serif"
    font-size="${fontSize}" font-weight="600">${name}</text>
</svg>`)
  const textPng = await sharp(textSvg).png().toBuffer()
  const gap = Math.round(18 * scale)
  const totalH = badge.size + gap + Math.round(48 * scale)
  const top = Math.round((height - totalH) / 2)
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: bg,
    },
  })
    .composite([
      { input: badge.buffer, top, left: Math.round((width - badge.size) / 2) },
      { input: textPng, top: top + badge.size + gap, left: 0 },
    ])
    .png()
    .toBuffer()
}

async function sidebar({ width, height, dark }) {
  const scale = width / 164
  const badge = await circleBadge(dark ? '#1f2124' : '#FFFFFF', dark ? '#F9FAFB' : '#0F1115', scale * 1.1)
  const fontSize = Math.round(14 * scale)
  const textSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(80 * scale)}">
  <text x="50%" y="40%" text-anchor="middle" fill="${dark ? '#F9FAFB' : '#0F1115'}"
    font-family="Microsoft YaHei UI, PingFang SC, sans-serif"
    font-size="${fontSize}" font-weight="600">江西中软</text>
  <text x="50%" y="75%" text-anchor="middle" fill="${dark ? '#F9FAFB' : '#0F1115'}"
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
      { input: badge.buffer, top, left: Math.round((width - badge.size) / 2) },
      { input: textPng, top: top + badge.size + Math.round(16 * scale), left: 0 },
    ])
    .png()
    .toBuffer()
}

const transparent = { r: 0, g: 0, b: 0, alpha: 0 }

const jobs = [
  ['brand.png', await brand({
    width: 600, height: 196, scale: 1,
    bg: transparent, text: '#0F1115', logoInner: '#0F1115', circleFill: '#FFFFFF',
  })],
  ['brand-2x.png', await brand({
    width: 1200, height: 392, scale: 2,
    bg: transparent, text: '#0F1115', logoInner: '#0F1115', circleFill: '#FFFFFF',
  })],
  ['brand-dark.png', await brand({
    width: 600, height: 196, scale: 1,
    bg: transparent, text: '#F9FAFB', logoInner: '#F9FAFB', circleFill: '#1f2124',
  })],
  ['brand-dark-2x.png', await brand({
    width: 1200, height: 392, scale: 2,
    bg: transparent, text: '#F9FAFB', logoInner: '#F9FAFB', circleFill: '#1f2124',
  })],
  ['uninstaller-sidebar.png', await sidebar({ width: 164, height: 314, dark: false })],
]

for (const [file, buffer] of jobs) {
  writeFileSync(join(outDir, file), buffer)
  console.log('wrote', file, buffer.length)
}
