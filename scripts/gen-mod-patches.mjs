/**
 * 从 dsh 源码仓库重新生成一个 mod 的代码级补丁与子包产物。
 *
 * 为什么需要这个脚本：mod 的补丁是打在 **npm 发布产物**（打包后的 lib/index.js）上的，
 * 而 dsh 每发一版那些文件都会变，补丁十有八九贴不上。上游一升级就得重做一遍 ——
 * 之前这一步没有脚本，全靠手工比对，于是每次升级都变成一场事故。
 *
 * 做法：把「源码仓库构建出的产物」和「同版本 npm 发布的产物」对比。
 * 两边用同一套工具链构建，差异就只剩 mod 自己的改动 —— 实测四个包分别只差
 * 39 / 48 / 14 / 4 行，干净得可以直接当补丁用。
 *
 * 前提：源码仓库已经 rebase 到目标版本并构建过（npm run build:lib）。
 *
 * 用法：
 *   node scripts/gen-mod-patches.mjs \
 *     --source ~/deepseek-harness/dsh-source \
 *     --stock  "~/Library/Application Support/Krill/dsh" \
 *     --pack   ~/.dsh/desktop-plugins/@dsh-external/dsh-vision-pack
 */
import { spawnSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync,
} from 'node:fs'
import { join, basename } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const SOURCE = arg('source')
const STOCK = arg('stock')
const PACK = arg('pack')
if (SOURCE === undefined || STOCK === undefined || PACK === undefined) {
  console.error('用法：--source <dsh-source> --stock <未打补丁的运行时根> --pack <mod 目录>')
  process.exit(2)
}

/** 扫源码仓库，建「包名 → 目录」的映射，不写死路径。 */
function sourcePackageMap(root) {
  const map = new Map()
  const packages = join(root, 'packages')
  for (const group of readdirSync(packages)) {
    const groupDir = join(packages, group)
    try { if (!statSync(groupDir).isDirectory()) continue } catch { continue }
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name)
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (typeof pkg.name === 'string') map.set(pkg.name, dir)
      } catch { /* 不是包，跳过 */ }
    }
  }
  return map
}

/** 读某个包在 stock 运行时里的版本。 */
function stockVersion(pkgName) {
  try {
    const p = join(STOCK, 'node_modules', ...pkgName.split('/'), 'package.json')
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch { return null }
}

const packManifestPath = join(PACK, 'package.json')
const packManifest = JSON.parse(readFileSync(packManifestPath, 'utf8'))
const decls = packManifest.krill?.corePatches ?? []
if (decls.length === 0) {
  console.error('mod 的 package.json 里没有 krill.corePatches')
  process.exit(2)
}

const srcMap = sourcePackageMap(SOURCE)
let target = null
let failed = 0

console.log('=== 生成补丁 ===')
for (const d of decls) {
  const srcDir = srcMap.get(d.package)
  if (srcDir === undefined) {
    console.error(`  ✗ ${d.package}：源码仓库里找不到这个包`)
    failed += 1
    continue
  }
  const rel = d.verify?.file ?? 'lib/index.js'
  const stockFile = join(STOCK, 'node_modules', ...d.package.split('/'), rel)
  const builtFile = join(srcDir, rel)
  if (!existsSync(stockFile) || !existsSync(builtFile)) {
    console.error(`  ✗ ${d.package}：缺 ${!existsSync(stockFile) ? stockFile : builtFile}`)
    failed += 1
    continue
  }

  // diff 的退出码：0=无差异，1=有差异，>1=出错。有差异才是我们要的正常情况
  const r = spawnSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, stockFile, builtFile],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status === 0) {
    // 踩过：先给运行时打了补丁再来生成，--stock 就不再是 stock，两边自然一样。
    // 这个提示要把两种可能都说出来，否则会照着「没构建」的方向白查半天。
    console.error(`  ✗ ${d.package}：两份产物完全相同。要么源码仓库没构建，`
      + '要么 --stock 指向的运行时已经打过补丁了 —— 它必须是干净的发布版')
    failed += 1
    continue
  }
  if (r.status !== 1) {
    console.error(`  ✗ ${d.package}：diff 出错 ${r.stderr ?? ''}`)
    failed += 1
    continue
  }

  const out = join(PACK, d.file)
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, r.stdout, 'utf8')
  const lines = r.stdout.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length
  const v = stockVersion(d.package)
  if (v !== null) target = v
  console.log(`  ✓ ${d.package} → ${d.file}（${lines} 行改动，针对 ${v ?? '未知版本'}）`)
}

if (failed > 0) {
  console.error(`\n${failed} 个补丁没生成，中止 —— 半套补丁比没有更危险`)
  process.exit(1)
}

// 版本声明跟着一起更新，否则装的时候会拿旧版本号去比范围
if (target !== null) {
  for (const d of packManifest.krill.corePatches) {
    d.authoredFor = target
    // 不写 appliesTo：插件不锁 dsh 版本。范围声明只会让「本来贴得上」的升级
    // 被提前拒绝，而贴不贴得上只有 patch 自己知道。
    delete d.appliesTo
  }
  writeFileSync(packManifestPath, `${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
  console.log(`\n=== 版本声明已更新为 ${target} ===`)
}

// 子包产物：mod 里装的是构建好的 lib/，源码一变就得跟着换
console.log('\n=== 同步子包产物 ===')
const subs = join(PACK, 'packages')
for (const name of existsSync(subs) ? readdirSync(subs) : []) {
  const subDir = join(subs, name)
  let subName
  try { subName = JSON.parse(readFileSync(join(subDir, 'package.json'), 'utf8')).name } catch { continue }
  const srcDir = srcMap.get(subName)
  if (srcDir === undefined) {
    console.error(`  ✗ ${subName}：源码仓库里找不到`)
    failed += 1
    continue
  }
  const srcLib = join(srcDir, 'lib')
  if (!existsSync(srcLib)) {
    console.error(`  ✗ ${subName}：源码里没有 lib/，先构建`)
    failed += 1
    continue
  }
  const dstLib = join(subDir, 'lib')
  mkdirSync(dstLib, { recursive: true })
  let n = 0
  for (const f of readdirSync(srcLib)) {
    // tsbuildinfo 是构建缓存、types 是目录，都不该进 mod
    if (f.endsWith('.tsbuildinfo')) continue
    const s = join(srcLib, f)
    try { if (statSync(s).isDirectory()) continue } catch { continue }
    copyFileSync(s, join(dstLib, f))
    n += 1
  }
  console.log(`  ✓ ${subName} ← ${basename(srcDir)}/lib（${n} 个文件）`)
}

if (failed > 0) process.exit(1)
console.log('\n完成。接下来：node scripts/pack-mod.mjs 重新打包，再重装 mod。')
