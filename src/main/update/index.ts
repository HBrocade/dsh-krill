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
import type { UpdateReport } from '@shared/ipc'

let report: UpdateReport = {
  checkedAt: null,
  checking: false,
  cli: { current: null, latest: null, upgradable: false, error: null },
  plugins: [],
  sourceRepo: { path: '', exists: false, branch: null, behind: 0, ahead: 0, dirty: false, error: null },
  app: { configured: false, current: '0.0.0', latest: null, status: 'idle', progressPercent: null, error: null },
}

const listeners = new Set<(r: UpdateReport) => void>()
let timer: NodeJS.Timeout | null = null
let inFlight: Promise<UpdateReport> | null = null

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
      cli: cliResult,
      plugins: pluginResult,
      sourceRepo: repoResult,
      app: appResult,
    })

    const n = pendingCount()
    log(`更新检查完成：${n === 0 ? '全部最新' : `${n} 项可更新`}`
      + (cliResult.upgradable ? `（dsh ${cliResult.current} → ${cliResult.latest}）` : ''))
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

/** 一键升级 dsh CLI。升级完不自动重启后端 —— 何时重启由用户决定。 */
export async function upgradeCli(): Promise<string> {
  const latest = report.cli.latest
  if (latest === null) throw new Error('还没查到可用版本，先跑一次检查')
  if (!report.cli.upgradable) throw new Error(`当前已是 ${report.cli.current}，无需升级`)
  const got = await cli.install(latest)
  patch({ cli: { ...report.cli, current: got, upgradable: false } })
  return got
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
