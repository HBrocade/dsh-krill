/**
 * 更新中心编排：四类检测汇成一份状态，定时刷新，变化广播给界面与托盘。
 *
 * 四类互不阻塞 —— 任何一类失败只污染自己那一格，其余照常出结果。
 * 网络断了不该让整个面板空白。
 */
import { clearCache } from './registry.ts'
import * as cli from './cli.ts'
import * as plugins from './plugins.ts'
import * as sourceRepo from './source-repo.ts'
import * as appUpdate from './app.ts'
import { log } from '../backend/log-ring.ts'
import { loadConfig } from '../config/store.ts'
import { desktopPluginsRoot } from '../plugins/inventory.ts'
import * as corePatch from '../plugins/core-patch.ts'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateReport } from '@shared/ipc'

let report: UpdateReport = {
  checkedAt: null,
  checking: false,
  cli: {
    current: null, latest: null, upgradable: false, error: null,
    upgrading: false, upgradeStep: null,
  },
  plugins: [],
  sourceRepo: { path: '', exists: false, branch: null, behind: 0, ahead: 0, dirty: false, error: null },
  app: { configured: false, current: '0.0.0', latest: null, status: 'idle', progressPercent: null, error: null },
}

const listeners = new Set<(r: UpdateReport) => void>()
let timer: NodeJS.Timeout | null = null
let inFlight: Promise<UpdateReport> | null = null
let upgradeInFlight: Promise<string> | null = null

export function getReport(): UpdateReport { return structuredClone(report) }

export function onChange(fn: (r: UpdateReport) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit(): void {
  const snap = getReport()
  for (const fn of listeners) {
    try { fn(snap) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

function patch(next: Partial<UpdateReport>): void {
  report = { ...report, ...next }
  emit()
}

/**
 * 跑一轮全量检查。并发已在飞行时直接复用同一个 Promise ——
 * 面板上连点「立即检查」不该叠出多轮请求。
 */
export function checkAll(options: { force?: boolean; reason?: string } = {}): Promise<UpdateReport> {
  if (inFlight !== null) {
    log(`更新检查已在进行中，复用当前这轮（触发者：${options.reason ?? '未标注'}）`)
    return inFlight
  }
  inFlight = (async () => {
    log(`开始更新检查（触发：${options.reason ?? '未标注'}）`)
    patch({ checking: true })
    if (options.force === true) clearCache()

    const [cliResult, pluginResult, repoResult, appResult] = await Promise.all([
      cli.check(options).catch((e: unknown) => ({
        current: cli.currentVersion(), latest: null, upgradable: false,
        error: e instanceof Error ? e.message : String(e),
      })),
      plugins.check(options).catch(() => []),
      sourceRepo.check().catch((e: unknown) => ({
        path: loadConfig().sourceRepoPath, exists: false, branch: null,
        behind: 0, ahead: 0, dirty: false,
        error: e instanceof Error ? e.message : String(e),
      })),
      appUpdate.check().catch(() => appUpdate.snapshot()),
    ])

    patch({
      checking: false,
      checkedAt: Date.now(),
      // 瞬时的升级状态原样带过去 —— 定时检查可能正落在升级进行中
      cli: { ...cliResult, upgrading: report.cli.upgrading, upgradeStep: report.cli.upgradeStep },
      plugins: pluginResult,
      sourceRepo: repoResult,
      app: appResult,
    })

    // 出错的检测项在 pendingCount 里也算 0 —— 不单独报出来的话，
    // 「检查失败」和「全部最新」在日志里长得一模一样，排查时会被误导。
    const errors: string[] = []
    if (cliResult.error !== null) errors.push(`dsh CLI: ${cliResult.error}`)
    if (repoResult.error !== null) errors.push(`源码仓库: ${repoResult.error}`)
    if (appResult.error !== null) errors.push(`App 自更新: ${appResult.error}`)
    for (const p of pluginResult) {
      if (p.error !== null && p.source === 'registry') errors.push(`插件 ${p.name}: ${p.error}`)
    }

    const n = pendingCount()
    const detail = [
      cliResult.upgradable ? `dsh ${cliResult.current} → ${cliResult.latest}` : null,
      repoResult.exists && repoResult.behind > 0 ? `源码仓库落后 ${repoResult.behind}` : null,
      pluginResult.filter((p) => p.upgradable).length > 0
        ? `${pluginResult.filter((p) => p.upgradable).length} 个插件可升级` : null,
    ].filter((x): x is string => x !== null)

    log(`更新检查完成：${n === 0 ? '无可更新项' : `${n} 项可更新`}`
      + (detail.length > 0 ? `（${detail.join('；')}）` : '')
      + (errors.length > 0 ? ` —— 另有 ${errors.length} 项检查失败` : ''),
      errors.length > 0 ? 'stderr' : 'app')
    for (const e of errors) log(`  检查失败 · ${e}`, 'stderr')
    return getReport()
  })().finally(() => { inFlight = null })
  return inFlight
}

/** 可更新项总数，托盘角标用。 */
export function pendingCount(): number {
  let n = 0
  if (report.cli.upgradable) n += 1
  n += report.plugins.filter((p) => p.upgradable).length
  if (report.app.status === 'available' || report.app.status === 'downloaded') n += 1
  if (report.sourceRepo.exists && report.sourceRepo.behind > 0) n += 1
  return n
}

/**
 * 列出当前**已应用**的代码级补丁。
 *
 * 升级运行时是 `npm install --prefix` 覆盖整棵树，这些补丁会被一并冲掉，
 * 而且没有任何东西会自动重打。更要命的是：mod 的插件代码 import 的正是补丁加进去的
 * 导出（`IMAGE_PLACEHOLDER` 之类），冲掉之后后端不是「功能失效」而是**根本起不来**。
 * 所以升级前必须拦一道。
 */
function appliedCorePatches(): Array<{ plugin: string; package: string }> {
  const root = desktopPluginsRoot()
  if (!existsSync(root)) return []
  const dirs: string[] = []
  const scan = (base: string, depth: number): void => {
    let names: string[]
    try { names = readdirSync(base) } catch { return }
    for (const n of names) {
      const d = join(base, n)
      if (existsSync(join(d, 'package.json'))) dirs.push(d)
      else if (depth > 0) scan(d, depth - 1)   // @scope/ 那一层
    }
  }
  scan(root, 1)
  const out: Array<{ plugin: string; package: string }> = []
  for (const d of dirs) {
    for (const st of corePatch.inspect(d)) {
      if (st.applied) out.push({ plugin: d.slice(root.length + 1), package: st.package })
    }
  }
  return out
}

/**
 * 一键升级 dsh CLI。升级完不自动重启后端 —— 何时重启由用户决定。
 *
 * 重复调用复用同一次升级：面板切 tab 会让按钮重新可点，两次 `npm install --prefix`
 * 同时往一个目录写会互相踩，装出一棵谁也说不清的树。
 */
export function upgradeCli(): Promise<string> {
  if (upgradeInFlight !== null) return upgradeInFlight

  const latest = report.cli.latest
  if (latest === null) return Promise.reject(new Error('还没查到可用版本，先跑一次检查'))
  if (!report.cli.upgradable) return Promise.reject(new Error(`当前已是 ${report.cli.current}，无需升级`))

  const applied = appliedCorePatches()
  if (applied.length > 0) {
    const list = applied.map((a) => `${a.plugin} → ${a.package}`).join('；')
    return Promise.reject(new Error(
      `已拦下升级：运行时上有 ${String(applied.length)} 处代码级补丁正在生效（${list}），`
      + '升级会连同整棵树把它们覆盖掉。这些补丁是按当前版本写的，新版本未必贴得上；'
      + '而 mod 的插件代码 import 的就是补丁加进去的导出 —— 冲掉之后后端会直接起不来，'
      + '不是功能降级。要升级请先卸载相关 mod，升完再装回（届时 mod 需针对新版本重新打包）。',
    ))
  }

  patch({ cli: { ...report.cli, upgrading: true, upgradeStep: '正在启动 npm…' } })
  upgradeInFlight = cli.install(latest, (line) => {
    patch({ cli: { ...report.cli, upgradeStep: line.slice(0, 200) } })
  })
    .then((got) => {
      patch({ cli: { ...report.cli, current: got, upgradable: false, upgrading: false, upgradeStep: null } })
      return got
    })
    .catch((e: unknown) => {
      patch({ cli: { ...report.cli, upgrading: false, upgradeStep: null } })
      throw e
    })
    .finally(() => { upgradeInFlight = null })
  return upgradeInFlight
}

export async function pullSourceRepo(): Promise<string> {
  const summary = await sourceRepo.pull()
  patch({ sourceRepo: await sourceRepo.check() })
  return summary
}

export const downloadApp = appUpdate.download
export const installApp = appUpdate.install

/**
 * 启动定时器。间隔 <= 0 表示只保留手动检查。
 * 首轮延后 20 秒：启动瞬间要让后端先起来、窗口先出来，别和它们抢带宽和 CPU。
 */
export function start(): void {
  appUpdate.subscribe(() => { patch({ app: appUpdate.snapshot() }) })

  const hours = loadConfig().updateIntervalHours
  setTimeout(() => { void checkAll({ reason: '启动后首轮' }) }, 20_000)
  if (hours <= 0) {
    log('更新定时检查已关闭（间隔 <= 0），仅保留手动检查')
    return
  }
  const ms = Math.max(1, hours) * 60 * 60 * 1000
  timer = setInterval(() => { void checkAll({ reason: '定时' }) }, ms)
  log(`更新定时检查：每 ${hours} 小时一次`)
}

export function stop(): void {
  if (timer !== null) { clearInterval(timer); timer = null }
}
