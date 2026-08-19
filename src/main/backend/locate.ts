/**
 * 定位 dsh 入口与 node 解释器。
 *
 * 优先级（高 → 低）：
 *   1. `DSH_BIN` 环境变量        —— 开发时指哪打哪
 *   2. userData 下的升级副本      —— 更新中心「一键升级 CLI」装到这里
 *   3. 随包内嵌的 resources/dsh   —— 出厂版本，签名后只读
 *   4. PATH 中的 dsh             —— 用户自己装的
 *
 * 第 2 条排在内嵌之前是有意的：`.app/Contents/Resources` 在签名后不可写，
 * 升级只能落到 userData，所以它必须能盖过出厂版本。
 */
import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DshSource = 'env' | 'userdata' | 'embedded' | 'path'

export interface LocatedDsh {
  /** dsh 的入口（lib/bin.js 或可执行文件） */
  bin: string
  /** 运行它的 node 解释器 */
  nodeBin: string
  source: DshSource
  version: string | null
  /** nodeBin 是 Electron 自身二进制时要设 ELECTRON_RUN_AS_NODE */
  needsElectronAsNode: boolean
}

function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true } catch { return false }
}

function which(cmd: string): string | null {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out !== '' && isExecutable(out) ? out : null
}

/** 升级副本的根目录，`npm install --prefix` 装到这里。 */
export function userDshRoot(): string {
  return join(app.getPath('userData'), 'dsh')
}

/**
 * 找 node。缺省用 PATH 里的；再没有就用 Electron 自带的 Node
 * （设 ELECTRON_RUN_AS_NODE=1 后 Electron 二进制可当纯 node 用），
 * 这样用户机器上没装 node 也能跑。
 */
export function findNode(): { bin: string; isElectron: boolean } {
  const fromEnv = process.env.DSH_NODE
  if (fromEnv !== undefined && fromEnv !== '' && isExecutable(fromEnv)) {
    return { bin: fromEnv, isElectron: false }
  }
  const fromPath = which('node')
  if (fromPath !== null) return { bin: fromPath, isElectron: false }
  return { bin: process.execPath, isElectron: true }
}

/** 从一个 dsh 安装根目录读版本号。读不到返回 null，不抛。 */
export function readDshVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function entryUnder(root: string): string | null {
  const candidate = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : null
}

export function locateDsh(): LocatedDsh | null {
  const node = findNode()
  const base = { nodeBin: node.bin, needsElectronAsNode: node.isElectron }

  const envBin = process.env.DSH_BIN
  if (envBin !== undefined && envBin !== '' && existsSync(envBin)) {
    return { ...base, bin: envBin, source: 'env', version: null }
  }

  const userRoot = userDshRoot()
  const userEntry = entryUnder(userRoot)
  if (userEntry !== null) {
    return { ...base, bin: userEntry, source: 'userdata', version: readDshVersion(userRoot) }
  }

  const embeddedRoot = join(process.resourcesPath ?? '', 'dsh')
  const embeddedEntry = entryUnder(embeddedRoot)
  if (embeddedEntry !== null) {
    return { ...base, bin: embeddedEntry, source: 'embedded', version: readDshVersion(embeddedRoot) }
  }

  // 开发模式：仓库里 resources/dsh（npm run embed 的产物）
  const devRoot = join(app.getAppPath(), 'resources', 'dsh')
  const devEntry = entryUnder(devRoot)
  if (devEntry !== null) {
    return { ...base, bin: devEntry, source: 'embedded', version: readDshVersion(devRoot) }
  }

  const onPath = which('dsh')
  if (onPath !== null) {
    // PATH 上的 dsh 是 shebang 脚本，仍显式用 node 跑，避免依赖它的 shebang 解析
    return { ...base, bin: onPath, source: 'path', version: null }
  }

  return null
}

/** 内嵌（出厂）版本，更新中心拿它和 registry 比对。 */
export function embeddedVersion(): string | null {
  const packed = readDshVersion(join(process.resourcesPath ?? '', 'dsh'))
  if (packed !== null) return packed
  return readDshVersion(join(app.getAppPath(), 'resources', 'dsh'))
}
