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
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hydratePath } from './user-path.ts'

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
  /** spawn 时要插在脚本路径**之前**的 node flag，见 {@link nodeFlagsFor} */
  nodeFlags: readonly string[]
}

/**
 * 拿 Electron 二进制当 node 用时必须补 `--expose-internals`。
 *
 * cordis 的 loader 需要 Node 的内部 ESM loader（`ctx.loader.internal`），正常路径是
 * 原生插件 `node-addon-require-builtin`。那个插件读 V8 的 embedder data，不是 N-API，
 * 在 Electron 里直接报 `Unsupported/no-realm`，拿不到。
 *
 * 后果远不止「HMR 用不了」：`loader.internal` 一空，cordis 解析 loader entry 的裸包名
 * 就退回从 **loader 自身所在文件** 往上溯，而不是从 profile 目录。in-box 插件恰好都在
 * 运行时那棵树里所以毫无察觉，out-of-tree 插件（注入器、mod）则全部 ERR_MODULE_NOT_FOUND，
 * 后端启动即崩 —— 而且崩得像是插件装坏了，跟真实原因（跑它的解释器不对）毫无关联。
 *
 * loader 自己留了旁路：`process.execArgv` 里有 `--expose-internals` 就直接
 * `require('internal/modules/esm/loader')`，不碰原生插件。走真 node 时插件能加载，
 * 不需要这个 flag。
 *
 * 三个 spawn 点（后端 / 桥接 runner / 插件命令）统一用这一份，避免下次只改一处。
 */
export function nodeFlagsFor(isElectron: boolean): readonly string[] {
  return isElectron ? ['--no-warnings', '--expose-internals'] : []
}

/**
 * `dsh --profile web` 要额外带的参数。
 *
 * rc.8 起 web profile 默认**用系统浏览器打开一份 UI**（新增的 dsh-web-app/lib/startup.js
 * 里 `openBrowser: options.open`，commander 的 --no-open 默认为 true）。我们自己就是壳，
 * 再弹一个浏览器纯属打扰 —— 用户升级到 rc.8 后一启动 Krill 就多一个浏览器窗口。
 *
 * rc.7 不认这个参数，给了会 `error: unknown option '--no-open'` 直接退出。
 * 所以按**能力探测**而不是版本号比较：直接看产物里有没有声明这个选项。
 * 版本号比较在 DSH_BIN 指向一份读不出版本的运行时时会失灵，探测不会。
 */
export function webProfileFlags(bin: string): string[] {
  // bin 形如 <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const libDir = join(bin, '..', '..', '..', 'dsh-web-app', 'lib')
  try {
    for (const f of readdirSync(libDir)) {
      if (!f.endsWith('.js')) continue
      if (readFileSync(join(libDir, f), 'utf8').includes('--no-open')) return ['--no-open']
    }
  } catch { /* 读不到就当不支持，宁可多一个浏览器窗口也别让后端起不来 */ }
  return []
}

function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true } catch { return false }
}

function whichOnce(cmd: string): string | null {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out !== '' && isExecutable(out) ? out : null
}

/**
 * 在 PATH 里找一个命令，找不到就把登录 shell 的 PATH 补进来再找一次。
 *
 * 从 Finder 启动时 launchd 只给最小 PATH，用户的 node / npm 一概看不见。
 * 见 {@link hydratePath}。
 */
export function which(cmd: string): string | null {
  const first = whichOnce(cmd)
  if (first !== null) return first
  hydratePath()
  return whichOnce(cmd)
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
  const base = {
    nodeBin: node.bin,
    needsElectronAsNode: node.isElectron,
    nodeFlags: nodeFlagsFor(node.isElectron),
  }

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
