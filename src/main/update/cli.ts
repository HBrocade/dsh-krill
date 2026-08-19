/**
 * dsh CLI 的版本检测与一键升级。
 *
 * 升级装到 **userData** 而不是 app bundle：`.app/Contents/Resources` 在签名后只读，
 * 往那儿写会失败。locate.ts 的优先级里 userData 排在内嵌之前，正是为了让升级生效。
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync, readdirSync, rmSync, renameSync, existsSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchVersions } from './registry.ts'
import { embeddedVersion, userDshRoot, readDshVersion, locateDsh, which } from '../backend/locate.ts'
import { log } from '../backend/log-ring.ts'
import { loadConfig } from '../config/store.ts'
import { isUpgrade } from '@shared/semver'
import type { CliUpdate } from '@shared/ipc'

const PKG = '@deepseek-ai/dsh'

/** 当前实际在用的版本：优先读正在运行的那份，回落到内嵌出厂版本。 */
export function currentVersion(): string | null {
  const located = locateDsh()
  if (located?.version != null) return located.version
  return readDshVersion(userDshRoot()) ?? embeddedVersion()
}

/**
 * 只产出「查出来的事实」。`upgrading` / `upgradeStep` 是主进程持有的瞬时状态，
 * 不能由一次检查覆盖 —— 定时检查完全可能落在一次升级进行到一半的时候。
 * atRiskPatches 同理：那是扫本地补丁状态得来的，和 registry 查询无关。
 */
export type CliFacts = Omit<CliUpdate, 'upgrading' | 'upgradeStep' | 'atRiskPatches'>

export async function check(options: { force?: boolean } = {}): Promise<CliFacts> {
  const current = currentVersion()
  try {
    const { latest, taggedLatest } = await fetchVersions(PKG, options)
    if (taggedLatest !== null && latest !== null && taggedLatest !== latest) {
      log(`注意：${PKG} 的 registry latest 标签是 ${taggedLatest}，实际最新是 ${latest} —— 按后者判断`)
    }
    return {
      current,
      latest,
      upgradable: current !== null && latest !== null && isUpgrade(current, latest),
      error: null,
    }
  } catch (e) {
    return { current, latest: null, upgradable: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 把指定版本装进 userData/dsh。
 * @returns 装完后实际读到的版本号
 * @throws npm 失败时抛，带上 npm 的输出尾部
 */
/**
 * 按配置准备 npm 的网络参数。
 *
 * 代理这件事只有一条路走得通，实测结论（用户 .npmrc 里放一个死代理，看能不能装上）：
 *   --noproxy='*'                失败 —— 盖不住
 *   --proxy= --https-proxy=      失败 —— 空值被当成没设，落回 .npmrc
 *   npm_config_proxy= 等环境变量  失败 —— 同上
 *   --userconfig <另一份 npmrc>   成功
 *
 * 所以走临时 npmrc：把用户那份原样抄过来、**只滤掉代理相关的行**，再按需要追加
 * registry。这样 token、scope 映射之类的配置都还在，只有代理被摘掉 ——
 * 直接塞一份空的 npmrc 会把私有源的认证一起弄丢。
 *
 * @returns 额外的 npm 参数；不需要动网络配置时为空数组
 */
function networkArgs(stagingDir: string): string[] {
  const cfg = loadConfig()
  const registry = cfg.npmRegistry.trim()
  const proxy = cfg.npmProxy.trim()
  if (registry === '' && proxy === '') return []   // 照 ~/.npmrc 办

  // 只在用户**明确**要改代理时才动代理行。
  // 之前这里无条件过滤，结果只填了 registry 也把 .npmrc 里的代理摘掉了 ——
  // 而「代理留空」的约定是「照 ~/.npmrc 办」，等于悄悄改了用户没要求改的东西。
  const overridesProxy = proxy !== ''
  const lines: string[] = []
  try {
    const userRc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
    for (const line of userRc.split('\n')) {
      if (overridesProxy
        && (/^\s*(https?-)?proxy\s*=/i.test(line) || /^\s*noproxy\s*=/i.test(line))) continue
      if (registry !== '' && /^\s*registry\s*=/i.test(line)) continue
      lines.push(line)
    }
  } catch { /* 没有用户 npmrc，从空的开始 */ }

  if (registry !== '') {
    lines.push(`registry=${registry}`)
    log(`npm registry：${registry}`)
  }
  if (proxy.toLowerCase() === 'off') {
    log('npm 代理：显式直连（临时 npmrc 里已摘掉代理行）')
  } else if (proxy !== '') {
    lines.push(`proxy=${proxy}`, `https-proxy=${proxy}`)
    log(`npm 代理：${proxy}`)
  }

  const rc = join(stagingDir, '.krill-npmrc')
  writeFileSync(rc, `${lines.join('\n')}\n`, 'utf8')
  return ['--userconfig', rc]
}

/**
 * 把暂存树换成正式的那棵。
 *
 * 两次 rename 都在同一个卷内，各自是原子的；中间那一瞬 userDshRoot() 不存在，
 * 但那时不会有人去读它 —— 后端仍跑在自己已打开的 inode 上，重启后才会走新路径。
 * 旧树留到最后再删，删失败也只是占点盘，不影响这次升级。
 */
function swapIn(staging: string): void {
  const live = userDshRoot()
  const retired = `${live}.old-${String(Date.now())}`
  if (existsSync(live)) renameSync(live, retired)
  renameSync(staging, live)
  try {
    rmSync(retired, { recursive: true, force: true })
  } catch (e) {
    log(`旧运行时没删掉，可手动清理 ${retired}：${e instanceof Error ? e.message : String(e)}`, 'stderr')
  }
}

/**
 * 装到旁边再整体替换，**绝不就地改写正在用的那棵树**。
 *
 * 就地装的实测后果：npm 用「重命名成 .xxx-随机后缀 再换上新的」来替换每个包，
 * 而后端正跑在这棵树上、文件被占着，中途炸出
 *   ENOTEMPTY: rename 'node_modules/accepts' -> 'node_modules/.accepts-9IgAtCyr'
 * 留下 152 个孤儿临时目录、丢了一整个包，后端直接起不来。
 *
 * 还有第二个理由：就地装等于「在旧树上求解依赖」，npm 会保留所有仍满足版本范围的包。
 * 降级时尤其致命 —— 实测 rc.8 → rc.7 只把顶层元包降了回去，子包全留在 rc.8，
 * 装出一棵混合树。空目录里装才能得到那个版本**确切**的树。
 */
function stagingRoot(): string { return `${userDshRoot()}.next` }

/** 下一次 install 强制全量（增量装出混合树时置位）。 */
let fullReinstallNext = false

/**
 * 把暂存目录准备好。
 *
 * @param seed true = 先把现有运行时克隆过去，让 npm 只改动差异；false = 空目录全量装
 *
 * 克隆用 `cp -c`（APFS clonefile，写时复制）：实测 306MB 用时 6 秒、磁盘几乎不增。
 * 不这么做的话每次升级都是全量 —— 从零解析 1300 多个包的元数据、下载整整 300MB，
 * 而 rc.7 到 rc.8 之间大部分包压根没变。
 *
 * 非 APFS 卷退回普通 `cp -R`：多花点时间和空间，仍然远比全量下载便宜。
 */
function prepareStaging(seed: boolean, onOutput?: (line: string) => void): boolean {
  const staging = stagingRoot()
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  if (!seed) return false

  const live = userDshRoot()
  const liveModules = join(live, 'node_modules')
  if (!existsSync(liveModules)) return false

  const dest = join(staging, 'node_modules')
  onOutput?.('正在克隆现有运行时（写时复制，不占额外空间）…')
  let ok = spawnSync('cp', ['-c', '-R', liveModules, dest]).status === 0
  if (!ok) {
    onOutput?.('该卷不支持写时复制，改用普通复制…')
    ok = spawnSync('cp', ['-R', liveModules, dest]).status === 0
  }
  if (!ok) {
    rmSync(dest, { recursive: true, force: true })
    log('克隆现有运行时失败，改为全量安装', 'stderr')
    return false
  }
  // 有 package.json / lock 的话一并带上，npm 才知道现在这棵树是什么
  for (const f of ['package.json', 'package-lock.json']) {
    const src = join(live, f)
    if (existsSync(src)) copyFileSync(src, join(staging, f))
  }
  return true
}

/**
 * 校验树里 dsh 家族的版本是否整齐。
 *
 * 增量安装的代价：npm 在已有的树上求解，会**保留所有仍满足版本范围的包**。
 * 升级时通常无害，降级时致命 —— 实测 rc.8 → rc.7 只把顶层元包降了回去，
 * 子包全留在 rc.8。所以装完必须回读核对，不齐就退回全量重来。
 *
 * 只查 `@deepseek-ai/dsh*`：同一批发布，版本号必然一致。
 * cordis、schemastery 这些有自己的版本线，不能一起比。
 */
function familyVersionsMatch(root: string, want: string): boolean {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  let names: string[]
  try { names = readdirSync(scope) } catch { return false }
  for (const n of names) {
    if (!n.startsWith('dsh')) continue
    try {
      const pkg = JSON.parse(readFileSync(join(scope, n, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version !== want) {
        log(`增量安装后版本不齐：@deepseek-ai/${n} 是 ${pkg.version}，期望 ${want}`, 'stderr')
        return false
      }
    } catch { /* 读不到就跳过，下面 bin.js 那道校验会兜住 */ }
  }
  return true
}

export function install(version: string, onOutput?: (line: string) => void): Promise<string> {
  const target = stagingRoot()
  const seeded = prepareStaging(!fullReinstallNext, onOutput)
  fullReinstallNext = false
  // networkArgs 会往暂存目录写临时 npmrc，必须在目录建好之后
  const args = [
    'install', '--prefix', target, '--no-audit', '--no-fund', '--no-save',
    // 没有 TTY 时 npm 默认几乎不出声 —— 实测装 300MB 的树全程只有两行
    // （一个空行 + 最后的 "added N packages in 8m"），面板看起来和卡死一样。
    // http 级别每个包请求一行，是无 TTY 下唯一能拿到的真实进度。
    '--loglevel=http',
    // 空目录装 = 没有 lockfile，整棵树要现解析：实测 1300 多次元数据请求。
    //
    // 慢在重试退避，不在网速：实测 14 次请求各卡了 10 秒整 —— 那是
    // fetch-retry-mintimeout 的默认值，重试本身只花 18ms。调到 2 秒。
    //
    // 没有加 --maxsockets：首次请求失败多半是镜像站在高并发下限流，
    // 加大并发只会更糟。默认 15 条已经够。
    '--fetch-retry-mintimeout=2000',
    '--fetch-retry-maxtimeout=15000',
    // 缓存里有的直接用，只对缺的走网络。失败重来时这一条能省掉大半请求 ——
    // 上一次失败的尝试已经把元数据抓进缓存了。
    '--prefer-offline',
    ...networkArgs(target),
    '--omit', 'dev', `${PKG}@${version}`,
  ]
  log(`升级 dsh → ${version}（装入 ${target}）`)

  return new Promise((resolve, reject) => {
    // 必须用解析出的绝对路径：从 Finder 启动时 launchd 只给最小 PATH，
    // 裸 'npm' 会直接 ENOENT —— 而开发者在终端里永远复现不了
    const npm = which('npm')
    if (npm === null) {
      reject(new Error(
        '找不到 npm。升级 dsh 运行时需要它 —— 请确认已装 Node.js，'
        + '且 npm 在登录 shell 的 PATH 里（App 会从登录 shell 读一次 PATH）。',
      ))
      return
    }
    const proc = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const startedAt = Date.now()
    const tail: string[] = []
    let lastLineAt = Date.now()

    // npm 先把整棵树解析完才开始落盘，所以头几分钟 node_modules 根本不存在。
    // 数 http 行就能知道解析进行到哪了 —— 否则界面上只有一个不动的计时器。
    let fetched = 0
    const remember = (chunk: Buffer): void => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        lastLineAt = Date.now()
        tail.push(line)
        if (tail.length > 40) tail.shift()
        if (line.startsWith('npm http')) {
          fetched += 1
          // http 行有一千多条，全写进日志会把别的都冲掉；只喂面板
        } else {
          onOutput?.(line)
          log(line, 'stdout')
        }
      }
    }
    proc.stdout?.on('data', remember)
    proc.stderr?.on('data', remember)

    /**
     * 心跳。
     *
     * http 行只覆盖解析与下载；解压落盘那几分钟 npm 一声不吭，而那恰恰是最久的一段。
     * 所以静默超过 3 秒就自己报一次：已用时 + 已落盘的包数（读 node_modules 顶层项数，
     * 比 du 便宜得多）。宁可报个粗略的数，也不要让人对着不动的界面猜死没死。
     */
    const nodeModules = join(target, 'node_modules')
    const beat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000)
      const mmss = `${String(Math.floor(secs / 60))}:${String(secs % 60).padStart(2, '0')}`
      let written = 0
      try { written = readdirSync(nodeModules).length } catch { /* 解析阶段还没建出来 */ }
      const quiet = Date.now() - lastLineAt > 8_000 ? '（当前请求较慢，正在重试…）' : ''
      onOutput?.(written > 0
        ? `正在落盘… ${String(written)} 个包 · 已用时 ${mmss}`
        : `正在解析依赖… 已请求 ${String(fetched)} 个包的元数据 · 已用时 ${mmss}${quiet}`)
    }, 1_000)

    const done = (): void => { clearInterval(beat) }
    proc.on('error', (err) => { done(); reject(new Error(`无法启动 npm：${err.message}`)) })
    proc.on('exit', (code) => {
      done()
      if (code !== 0) {
        reject(new Error(`npm 退出码 ${code}。最后几行：\n${tail.slice(-8).join('\n')}`))
        return
      }
      const got = readDshVersion(target)
      if (got === null) {
        reject(new Error(`装完了但在 ${target} 读不到版本号，安装可能不完整`))
        return
      }
      // 换上去之前先确认入口在 —— 半棵树换上去比装失败更难查
      if (!existsSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
        reject(new Error(`暂存目录里没有 lib/bin.js，安装不完整，已保留现场：${target}`))
        return
      }
      // 增量装出混合树的话，重来一次全量的
      if (seeded && !familyVersionsMatch(target, got)) {
        onOutput?.('增量安装后版本不齐，改用全量重装…')
        log('增量安装后版本不齐，改为全量重装')
        fullReinstallNext = true
        install(version, onOutput).then(resolve).catch(reject)
        return
      }
      try {
        onOutput?.('正在替换运行时…')
        swapIn(target)
      } catch (e) {
        reject(new Error(`新版本装好了但替换失败：${e instanceof Error ? e.message : String(e)}`))
        return
      }
      log(`dsh 已升级到 ${got}`)
      resolve(got)
    })
  })
}

/** userData 里那份升级副本的版本（没装过为 null），面板用来区分「出厂版」与「已升级」。 */
export function upgradedVersion(): string | null {
  return readDshVersion(userDshRoot())
}

/** 出厂内嵌版本，仅供面板显示对照。 */
export function factoryVersion(): string | null {
  return embeddedVersion()
}

export function userDataDshPath(): string {
  return userDshRoot()
}

