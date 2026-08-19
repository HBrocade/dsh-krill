/**
 * dsh CLI 的版本检测与一键升级。
 *
 * 升级装到 **userData** 而不是 app bundle：`.app/Contents/Resources` 在签名后只读，
 * 往那儿写会失败。locate.ts 的优先级里 userData 排在内嵌之前，正是为了让升级生效。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fetchVersions } from './registry.ts'
import { embeddedVersion, userDshRoot, readDshVersion, locateDsh, which } from '../backend/locate.ts'
import { log } from '../backend/log-ring.ts'
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
export function install(version: string, onOutput?: (line: string) => void): Promise<string> {
  const target = userDshRoot()
  mkdirSync(target, { recursive: true })
  const args = [
    'install', '--prefix', target, '--no-audit', '--no-fund', '--no-save',
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
    const tail: string[] = []
    const remember = (chunk: Buffer): void => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
        onOutput?.(line)
        log(line, 'stdout')
      }
    }
    proc.stdout?.on('data', remember)
    proc.stderr?.on('data', remember)
    proc.on('error', (err) => { reject(new Error(`无法启动 npm：${err.message}`)) })
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`npm 退出码 ${code}。最后几行：\n${tail.slice(-8).join('\n')}`))
        return
      }
      const got = readDshVersion(target)
      if (got === null) {
        reject(new Error(`装完了但在 ${target} 读不到版本号，安装可能不完整`))
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

