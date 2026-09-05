#!/usr/bin/env node
/**
 * 把一个 mod 目录打成可分发的 .tgz。
 *
 * 打包前做一轮校验 —— 这些检查全部来自实测踩过的坑，
 * 每一条都对应一次「装上去才发现坏了」：
 *
 *  1. loader 行不能指向浏览器产物。cordis 的 loader 跑在 Node 里，
 *     name 指向 client bundle 会让 dsh 以 `window is not defined` 启动即崩。
 *  2. 产物里自注册的包名必须和 package.json 的 name 一致。client bundle 通过
 *     `__ModuleLoader__.load("<包名>")` 自报家门，改了包名却不重建产物，
 *     浏览器侧会报 "loaded without registering"。
 *  3. 声明了代码级补丁就必须带上补丁文件，且每处补丁要有回读探针 ——
 *     没有探针就无法区分「补丁应用了」与「补丁产生了预期效果」。
 *  4. 声明了 dsh.client 就必须有 client 产物，否则装上去静默无 UI。
 *
 * 用法：node scripts/pack-mod.mjs <mod 目录> [输出目录]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { parse } from 'yaml'

const modDir = resolve(process.argv[2] ?? '')
const outDir = resolve(process.argv[3] ?? join(modDir, '..', 'dist'))

if (!existsSync(join(modDir, 'package.json'))) {
  console.error(`不是一个 mod 目录（没有 package.json）：${modDir}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf8'))
const problems = []
const notes = []

// ── 1. loader 行不能指向浏览器产物 ──────────────────────────────────────────
const patchPath = pkg.dsh?.bundle?.patch
if (typeof patchPath === 'string') {
  const f = join(modDir, patchPath)
  if (!existsSync(f)) problems.push(`dsh.bundle.patch 指向的文件不存在：${patchPath}`)
  else {
    let rows = []
    try {
      const doc = parse(readFileSync(f, 'utf8'))
      for (const entry of Array.isArray(doc) ? doc : []) {
        for (const r of Array.isArray(entry?.insert) ? entry.insert : []) rows.push(r)
      }
    } catch (e) {
      problems.push(`${patchPath} 解析失败：${e.message}`)
    }
    // 纯补丁 / 纯路线的 mod 没有 loader 行是正常的 —— 它靠 krill.corePatches 或
    // krill.routes 起作用，dsh.bundle.patch 只是为了让 dsh plugin add 把它登进 bundles
    const doesSomethingElse = (pkg.krill?.corePatches?.length ?? 0) > 0
      || Object.keys(pkg.krill?.routes ?? {}).length > 0
    if (rows.length === 0 && !doesSomethingElse) {
      problems.push(`${patchPath} 里没有任何 insert 行，也没有代码级补丁或路线声明 —— 装上去什么都不做`)
    }
    for (const r of rows) {
      if (typeof r?.name !== 'string') continue
      if (/\/client$/.test(r.name)) {
        problems.push(
          `loader 行 "${r.id ?? '?'}" 指向了 ${r.name} —— loader 跑在 Node 里，`
          + '不能 import 浏览器产物。client 半边应由 package.json 的 dsh.client 声明带出。',
        )
      }
    }
    notes.push(`loader 行 ${rows.length} 条：${rows.map((r) => r.id ?? '?').join('、')}`)
  }
}

// ── 2/4. 子包的自注册名与 client 产物 ───────────────────────────────────────
const subPkgDir = join(modDir, 'packages')
if (existsSync(subPkgDir)) {
  for (const name of readdirSync(subPkgDir)) {
    const d = join(subPkgDir, name)
    if (!statSync(d).isDirectory()) continue
    const sub = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    const client = sub.dsh?.client
    const clientJs = join(d, 'lib', 'client.js')
    if (client !== undefined && client !== null) {
      if (!existsSync(clientJs)) {
        problems.push(`${sub.name} 声明了 dsh.client 却没有 lib/client.js —— 装上去不会有 UI`)
      } else {
        const src = readFileSync(clientJs, 'utf8')
        if (!src.includes(`"${sub.name}"`) && !src.includes(`'${sub.name}'`)) {
          problems.push(
            `${sub.name} 的 client 产物里找不到自注册名 "${sub.name}" —— `
            + '产物是按另一个包名构建的，浏览器侧会报 loaded without registering。'
            + '改包名后必须重建 client 产物。',
          )
        }
      }
    }
    notes.push(`子包 ${sub.name}${client ? '（含 client 半边）' : ''}`)
  }
}

// ── 3. 代码级补丁 ───────────────────────────────────────────────────────────
const corePatches = pkg.krill?.corePatches ?? []
for (const c of corePatches) {
  if (!existsSync(join(modDir, c.file ?? ''))) {
    problems.push(`声明了补丁 ${c.package} 但文件不存在：${c.file}`)
  }
  if (c.verify?.contains === undefined) {
    problems.push(
      `补丁 ${c.package} 没有回读探针（krill.corePatches[].verify）—— `
      + '装完就无法区分「补丁应用了」与「补丁产生了预期效果」',
    )
  }
  if (typeof c.authoredFor !== 'string') {
    problems.push(`补丁 ${c.package} 缺 authoredFor —— 面板无法判断陈旧度`)
  }
}
if (corePatches.length > 0) {
  notes.push(`代码级补丁 ${corePatches.length} 处：${corePatches.map((c) => c.package).join('、')}`)
}

// ── 5. 路线声明 ─────────────────────────────────────────────────────────────
// 装的时候原样写进 settings.yaml，写错一个字段整条路线被 dsh 拒掉，而那是重启之后
// 才看得到的事。这里只查形状上一眼能看出来的：协议、端点、凭据引用、模型清单、头。
const routes = pkg.krill?.routes
if (routes !== undefined) {
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
    problems.push('krill.routes 必须是 id → 路线体 的字典（不是数组）')
  } else {
    let modelCount = 0
    for (const [id, r] of Object.entries(routes)) {
      if (r === null || typeof r !== 'object') { problems.push(`路线 ${id} 不是对象`); continue }
      if (typeof r.api !== 'string') problems.push(`路线 ${id} 缺 api（anthropic-messages / openai-completions / openai-responses）`)
      if (typeof r.baseURL !== 'string' || !/^https?:\/\//.test(r.baseURL)) problems.push(`路线 ${id} 的 baseURL 不是 http(s) 地址`)
      if (typeof r.apiKeyEnv !== 'string') problems.push(`路线 ${id} 缺 apiKeyEnv —— 用户没地方填 key`)
      const models = Array.isArray(r.models) ? r.models : []
      if (models.length === 0) problems.push(`路线 ${id} 没有 models —— 自声明路线的模型只能来自清单`)
      for (const m of models) {
        if (typeof m?.id !== 'string') problems.push(`路线 ${id} 有模型条目缺 id`)
      }
      modelCount += models.length
      if (r.headers !== undefined) {
        const bad = Object.entries(r.headers ?? {}).filter(([, v]) => typeof v !== 'string')
        if (r.headers === null || typeof r.headers !== 'object' || bad.length > 0) {
          problems.push(`路线 ${id} 的 headers 必须是字符串到字符串的字典`)
        }
      }
    }
    notes.push(`路线声明 ${Object.keys(routes).length} 条（${modelCount} 个模型）：${Object.keys(routes).join('、')}`)
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log(`mod：${pkg.name}@${pkg.version}`)
for (const n of notes) console.log(`  · ${n}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} 项校验未通过，拒绝打包：`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('  校验通过')

mkdirSync(outDir, { recursive: true })
// npm pack 会按 files 字段裁剪；这里用它是为了拿到和 npm 生态一致的 tarball 结构
const out = execFileSync('npm', ['pack', '--pack-destination', outDir, modDir], { encoding: 'utf8' })
const tgz = out.trim().split('\n').pop()
const full = join(outDir, basename(tgz))
console.log(`\n已打包：${full}`)
console.log(`  ${(statSync(full).size / 1024).toFixed(0)} KB`)
console.log('\n安装：在 Krill 的插件面板里填这个 .tgz 的路径，选「官方装配」。')
