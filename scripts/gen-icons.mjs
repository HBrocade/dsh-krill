#!/usr/bin/env node
/**
 * 应用图标全套生成。
 *
 * 源是 build/whale.png —— 从 AI 概念稿抠出的带透明通道主体
 * （抠图流程见 scripts/cutout.mjs：从边框洪水填充，保住眼白与嘴线）。
 * 这里只负责合成与出各档尺寸。
 *
 * 产物：
 *   build/icon.png            1024×1024，electron-builder 的通用输入
 *   build/icon.icns           macOS 应用图标
 *   build/trayTemplate.png    托盘单色图（+@2x）
 *   build/brand.png           侧栏品牌标（+@2x）
 *   build/icon.iconset/       中间产物，.gitignore 掉
 */
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const iconset = join(buildDir, 'icon.iconset')
const whaleSrc = join(buildDir, 'whale.png')

const SZ = 1024
const RADIUS = 229          // macOS squircle 惯例：约 22.4% 边长
const WHALE_WIDTH = 820     // 主体宽度，两侧各留约 10% 安全边

const BG_FROM = '#4D6BFE'
const BG_TO = '#3B52D6'

const squircle = Buffer.from(
  `<svg width="${SZ}" height="${SZ}" xmlns="http://www.w3.org/2000/svg">
     <defs><linearGradient id="g" x1="0.1" y1="0" x2="0.9" y2="1">
       <stop offset="0" stop-color="${BG_FROM}"/><stop offset="1" stop-color="${BG_TO}"/>
     </linearGradient></defs>
     <rect width="${SZ}" height="${SZ}" rx="${RADIUS}" fill="url(#g)"/>
   </svg>`)

const whale = await sharp(whaleSrc).resize(WHALE_WIDTH, null, { fit: 'inside' }).png().toBuffer()
const wm = await sharp(whale).metadata()
const left = Math.round((SZ - wm.width) / 2)
const top = Math.round((SZ - wm.height) / 2)

const master = await sharp(squircle).composite([{ input: whale, left, top }]).png().toBuffer()
await sharp(master).toFile(join(buildDir, 'icon.png'))
console.log('[icons] build/icon.png (1024)')

// 各档都从 1024 主图降采样。这里和矢量不同：位图没得选，
// 所以主体宽度刻意压到 820 —— 留足边距，小尺寸下剪影才不会顶到圆角。
const png = (size) => sharp(master).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 })

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const s of [16, 32, 128, 256, 512]) {
  await png(s).toFile(join(iconset, `icon_${s}x${s}.png`))
  await png(s * 2).toFile(join(iconset, `icon_${s}x${s}@2x.png`))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')], { stdio: 'inherit' })
console.log('[icons] build/icon.icns')

/**
 * 托盘 template 图：纯黑剪影 + alpha，macOS 按菜单栏明暗自动反色。
 * 从抠图的 alpha 通道取轮廓，丢掉全部内部明暗 —— 22px 下那些只是噪声。
 */
const silhouette = async (height) => {
  // 按**高度**定尺寸，宽度随比例 —— 菜单栏高度固定，托盘图可以比它宽。
  // 之前按 fit:inside 套进方框，22×22 的框只填出 22×12，白白丢掉一半高度。
  const a = await sharp(whaleSrc).resize(null, height, { fit: 'inside' }).ensureAlpha()
    .extractChannel('alpha').toBuffer()
  const meta = await sharp(a).metadata()
  // alpha 当作蒙版，铺一层纯黑
  return sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: '#000' } })
    .joinChannel(a).png()
}
// 18px 高：22px 菜单栏上下各留 2px 余量
await (await silhouette(18)).toFile(join(buildDir, 'trayTemplate.png'))
await (await silhouette(36)).toFile(join(buildDir, 'trayTemplate@2x.png'))
console.log('[icons] build/trayTemplate.png (+@2x)')

/**
 * 侧栏品牌标：用**合成后的图标**（蓝底 + 鲸），不是透明底的裸鲸。
 * 侧栏底色是深的（#080A10），黑鲸贴上去几乎看不见 —— 和图标不选深色底是同一个理由。
 * 蓝底方块自带对比，也让侧栏和 Dock 里的图标是同一个东西。
 */
await sharp(master).resize(60, 60).png().toFile(join(buildDir, 'brand.png'))
await sharp(master).resize(120, 120).png().toFile(join(buildDir, 'brand@2x.png'))
console.log('[icons] build/brand.png (+@2x)')
console.log('[icons] 完成')
