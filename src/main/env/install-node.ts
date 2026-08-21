/**
 * 代装一份 Node.js 到应用数据目录。
 *
 * 为什么不让用户自己装：装 Krill 的人不一定是开发者，「先去装个 Node」对他们
 * 不是一句话的事 —— 官网选版本、装 nvm、配 PATH，任何一步卡住都会变成
 * 「这软件用不了」。而 Krill 真正需要的只是一个能跑 npm 的解释器。
 *
 * 为什么不调 brew / 不要管理员权限：官方 tarball 解压即用，不进系统目录、
 * 不改用户的 shell 配置、不和已有的 Node 打架。卸载就是删一个目录。
 *
 * 装到 `<userData>/toolchain/node`，locate.ts 会优先用它。
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { log } from '../backend/log-ring.ts'

function toolchainRoot(): string {
  return join(app.getPath('userData'), 'toolchain')
}

/** Krill 自己装的那份 node 的路径；没装过返回 null。 */
export function toolchainNodeBin(): string | null {
  const bin = join(toolchainRoot(), 'node', 'bin', 'node')
  return existsSync(bin) ? bin : null
}

/** 这个平台有没有官方预编译包。 */
export function nodeInstallSupported(): boolean {
  if (process.platform === 'darwin') return process.arch === 'arm64' || process.arch === 'x64'
  if (process.platform === 'linux') return process.arch === 'arm64' || process.arch === 'x64'
  return false // Windows 是 zip 不是 tar.gz，解压方式不同，暂不支持
}

/** 官方发布索引里挑一个当前 LTS。 */
async function resolveLts(): Promise<{ version: string; url: string; dir: string }> {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  // 索引里的 key 和 process.platform 不是一套叫法，也不是「平台-架构-格式」的规律：
  // macOS 是 `osx-arm64-tar`（**没有** -gz，尽管下载的确实是 .tar.gz），
  // Linux 直接是 `linux-x64`。照直觉拼会一个都匹配不上。
  const fileKey = process.platform === 'darwin' ? `osx-${arch}-tar` : `linux-${arch}`

  const res = await fetch('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`拉取 Node 版本索引失败：HTTP ${String(res.status)}`)
  const list = (await res.json()) as Array<{ version: string; lts: false | string; files: string[] }>
  const lts = list.find((e) => e.lts !== false && e.files.includes(fileKey))
  if (lts === undefined) throw new Error(`官方索引里没有适配 ${platform}-${arch} 的 LTS 版本`)

  const dir = `node-${lts.version}-${platform}-${arch}`
  return { version: lts.version, url: `https://nodejs.org/dist/${lts.version}/${dir}.tar.gz`, dir }
}

/**
 * 下载并解压。
 *
 * 解到临时目录再整体改名 —— 中途失败不会留下一棵半截的树，
 * 而半截的 node 目录比没有更糟：locate.ts 会挑中它，然后每次 spawn 都失败。
 */
export async function installNode(onOutput?: (line: string) => void): Promise<string> {
  if (!nodeInstallSupported()) {
    throw new Error(`当前平台（${process.platform}/${process.arch}）没有可直接解压的官方包，请手动安装 Node.js`)
  }
  const root = toolchainRoot()
  mkdirSync(root, { recursive: true })

  onOutput?.('正在查询 Node.js 官方 LTS 版本…')
  const { version, url, dir } = await resolveLts()
  onOutput?.(`将安装 ${version}（${url}）`)
  log(`代装 Node.js ${version} → ${root}`)

  const staging = join(root, '.staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const tgz = join(staging, 'node.tar.gz')

  onOutput?.('正在下载…')
  const res = await fetch(url)
  if (!res.ok || res.body === null) throw new Error(`下载失败：HTTP ${String(res.status)}`)
  const total = Number(res.headers.get('content-length') ?? '0')
  let got = 0
  let lastReport = 0
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    got += chunk.length
    // 每 2MB 报一次就够 —— 报太密会把日志刷满，而下载本身也就几十 MB
    if (got - lastReport < 2 * 1024 * 1024) return
    lastReport = got
    onOutput?.(total > 0
      ? `下载中… ${String(Math.round((got / total) * 100))}%（${String(Math.round(got / 1048576))}MB）`
      : `下载中… ${String(Math.round(got / 1048576))}MB`)
  })
  await pipeline(source, createWriteStream(tgz))

  onOutput?.('正在解压…')
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', tgz, '-C', staging], { windowsHide: true })
    let err = ''
    p.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', (e) => { reject(new Error(`解压失败：${e.message}`)) })
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar 退出码 ${String(code ?? -1)}：${err.slice(-300)}`))
    })
  })

  const unpacked = join(staging, dir)
  if (!existsSync(join(unpacked, 'bin', 'node'))) {
    throw new Error(`解压完成但没找到 bin/node，包结构和预期不符：${unpacked}`)
  }

  const target = join(root, 'node')
  rmSync(target, { recursive: true, force: true })
  renameSync(unpacked, target)
  rmSync(staging, { recursive: true, force: true })

  const bin = join(target, 'bin', 'node')
  log(`Node.js 已装好：${bin}`)
  onOutput?.(`完成：${bin}`)
  return bin
}

/** 删掉 Krill 装的那份，回到用系统的。 */
export function removeNode(): void {
  const target = join(toolchainRoot(), 'node')
  rmSync(target, { recursive: true, force: true })
  log('已删除 Krill 代装的 Node.js')
  // 目录空了就一并清掉，别在用户的数据目录里留空壳
  try {
    if (readdirSync(toolchainRoot()).length === 0) rmSync(toolchainRoot(), { recursive: true, force: true })
  } catch { /* 读不到就算了 */ }
}
