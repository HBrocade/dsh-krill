#!/usr/bin/env node
/**
 * 把 @deepseek-ai/dsh 装进 resources/dsh，让 App 自包含。
 *
 * 版本怎么定（这是本项目的头号坑，别改成 `npm install @deepseek-ai/dsh` 了事）：
 * dsh 家族在 npm 上的 `latest` dist-tag 指向 0.0.1-rc.1，而实际最新是 0.1.0-rc.7。
 * 装 `latest` 会把一个远古版本塞进包里。所以这里拉 `versions` 全集、semver 排序取最大。
 *
 * 用法：
 *   node scripts/embed-dsh.mjs            # 自动挑最大版本
 *   node scripts/embed-dsh.mjs 0.1.0-rc.7 # 钉死某个版本
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maxVersion } from '../src/shared/semver.ts'

const PKG = '@deepseek-ai/dsh'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'dsh')

async function resolveVersion() {
  const explicit = process.argv[2]
  if (explicit !== undefined && explicit !== '') return explicit
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!res.ok) throw new Error(`registry 返回 ${res.status}`)
  const body = await res.json()
  const best = maxVersion(Object.keys(body.versions ?? {}))
  if (best === null) throw new Error('registry 里没有可用版本')
  const latestTag = body['dist-tags']?.latest
  if (latestTag !== undefined && latestTag !== best) {
    console.log(`[embed] 注意：registry 的 latest 标签是 ${latestTag}，实际最新是 ${best} —— 按后者装`)
  }
  return best
}

const version = await resolveVersion()
mkdirSync(target, { recursive: true })
console.log(`[embed] 安装 ${PKG}@${version} → ${target}`)
execFileSync('npm', [
  'install', '--prefix', target, '--no-audit', '--no-fund', '--no-save',
  '--omit', 'dev', `${PKG}@${version}`,
], { stdio: 'inherit' })

const entry = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(entry)) {
  console.error(`[embed] 失败：没有产出 ${entry}`)
  process.exit(1)
}
const got = JSON.parse(readFileSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
console.log(`[embed] 完成：${PKG}@${got}`)
console.log(`[embed] 入口 ${entry}`)
