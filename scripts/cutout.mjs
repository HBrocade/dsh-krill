#!/usr/bin/env node
/**
 * 从 AI 出的概念稿里把主体抠出来，产出带透明通道的 PNG。
 *
 * 关键点：**不能用亮度阈值直接切**。这张图里鲸鱼的眼白、嘴线、背部高光
 * 都是浅色，硬切会把它们一起挖穿。正确做法是从画布四边做洪水填充，
 * 只吃掉「与边框连通」的浅色区域 —— 主体内部的浅色不与边框连通，自然保住。
 *
 * 边缘不做硬切：落在过渡带里的像素按亮度给部分 alpha，这样放大后边缘不会有锯齿。
 */
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'

const [src, out] = process.argv.slice(2)

/** 洪水填充能穿过的亮度下限：白底 252、米色底 ~245 都在其上，鲸鱼体色远在其下 */
const FLOOD_MIN = 170
/** 过渡带：亮度 ≥ HI 完全透明，≤ LO 完全不透明，之间线性 */
const HI = 238
const LO = 176

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info
const lum = new Uint8Array(W * H)
for (let i = 0, p = 0; p < W * H; p += 1, i += C) {
  // Rec.709 亮度
  lum[p] = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) | 0
}

// 从四边 BFS，标记与边框连通的浅色像素
const bg = new Uint8Array(W * H)
const queue = new Int32Array(W * H)
let head = 0, tail = 0
const push = (p) => { if (!bg[p] && lum[p] >= FLOOD_MIN) { bg[p] = 1; queue[tail++] = p } }
for (let x = 0; x < W; x += 1) { push(x); push((H - 1) * W + x) }
for (let y = 0; y < H; y += 1) { push(y * W); push(y * W + W - 1) }
while (head < tail) {
  const p = queue[head++]
  const x = p % W, y = (p / W) | 0
  if (x > 0) push(p - 1)
  if (x < W - 1) push(p + 1)
  if (y > 0) push(p - W)
  if (y < H - 1) push(p + W)
}

// 只对「背景区」按亮度给渐变 alpha；主体区一律不透明
let minX = W, minY = H, maxX = -1, maxY = -1
for (let p = 0; p < W * H; p += 1) {
  const a = p * C + 3
  if (bg[p]) {
    const l = lum[p]
    const alpha = l >= HI ? 0 : l <= LO ? 255 : Math.round(255 * (HI - l) / (HI - LO))
    data[a] = alpha
    if (alpha > 8) {
      const x = p % W, y = (p / W) | 0
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  } else {
    data[a] = 255
    const x = p % W, y = (p / W) | 0
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
}

const bw = maxX - minX + 1, bh = maxY - minY + 1
await sharp(Buffer.from(data), { raw: { width: W, height: H, channels: C } })
  .extract({ left: minX, top: minY, width: bw, height: bh })
  .png()
  .toFile(out)

const kept = (() => { let n = 0; for (let p = 0; p < W * H; p += 1) if (!bg[p]) n += 1; return n })()
console.log(`抠图完成 → ${out}`)
console.log(`  主体包围盒 ${bw}×${bh}（原图 ${W}×${H}）`)
console.log(`  主体像素占比 ${(kept / (W * H) * 100).toFixed(1)}%`)
