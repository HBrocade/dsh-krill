/**
 * 用量与余额的编排。
 *
 * 两个数据源、两种性质，刻意不混在一起：
 *   · token 明细 —— 从磁盘上的会话日志投影，**精确**，零估算
 *   · 余额 —— 问 DeepSeek，**精确**；两次之间的差就是这段时间的真实花费
 *
 * 不算「这次会话花了多少钱」。那需要一张 三模型 × 三类 token × 峰谷两时段
 * 的价目表，还得跟住调价 —— 维护不住的东西不该做成看起来精确的数字。
 */
import { log } from '../backend/log-ring.ts'
import * as project from './project.ts'
import { fetchBalance, hasApiKey } from './balance.ts'
import { activeSessionId, onChange as onSessionChange } from '../window/active-session.ts'
import { watch as watchFile, type FSWatcher } from 'node:fs'
import type { BalanceInfo, UsageReport } from '@shared/ipc'

/** 上一次查到的余额，用来算差值。进程内保存即可 —— 跨重启的花费统计不是这个功能的目标。 */
let previous: BalanceInfo | null = null
let latest: BalanceInfo | null = null
let lastError: string | null = null

function assemble(): UsageReport {
  return {
    current: project.current(activeSessionId()),
    recent: project.recent(6),
    balance: latest,
    balanceDelta: previous !== null && latest !== null ? latest.total - previous.total : null,
    hasApiKey: hasApiKey(),
    error: lastError,
  }
}

/** 只读本地会话日志，不发任何网络请求 —— 面板打开时调这个。 */
export function state(): UsageReport {
  try {
    return assemble()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`用量投影失败：${msg}`, 'stderr')
    return {
      current: null, recent: [], balance: latest,
      balanceDelta: null, hasApiKey: hasApiKey(), error: msg,
    }
  }
}

/**
 * 手动刷新：重新投影本地日志，并**查一次余额**。
 *
 * 只在用户点刷新时才发网络请求，不做轮询 —— 平白多出的定时外发请求，
 * 既没必要，也让人不放心。
 */
export async function refresh(): Promise<UsageReport> {
  lastError = null
  try {
    const next = await fetchBalance()
    // 只有真的变过才推进 previous，否则连点两次刷新会把差值抹成 0
    if (latest !== null && latest.total !== next.total) previous = latest
    latest = next
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    log(`余额查询失败：${lastError}`, 'stderr')
  }
  return assemble()
}

// ─────────────────────────────────────────────────────────────────────────────
// 变更推送
// ─────────────────────────────────────────────────────────────────────────────

const subscribers = new Set<(r: UsageReport) => void>()
let watcher: FSWatcher | null = null
let watching: string | null = null
let debounce: NodeJS.Timeout | null = null

/** 订阅用量变化：会话切换、或当前会话有新内容落盘时触发。 */
export function onChanged(fn: (r: UsageReport) => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

function emit(): void {
  const r = state()
  for (const fn of subscribers) {
    try { fn(r) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

/**
 * 合并连续变更后再推。
 *
 * 流式回答时日志一直在追加，每个 chunk 推一次的话界面会疯狂重绘，
 * 而中间那些状态没人看得清。等安静 600ms 再算一次就够。
 */
function schedule(): void {
  if (debounce !== null) clearTimeout(debounce)
  debounce = setTimeout(() => { debounce = null; emit() }, 600)
}

/** 把文件监听切到某个会话上。 */
function rewatch(sessionId: string | null): void {
  const file = sessionId === null ? null : project.findById(sessionId)
  const path = file?.path ?? null
  if (path === watching) return
  watcher?.close()
  watcher = null
  watching = path
  if (path === null) return
  try {
    // 只听当前这一个文件，不听整棵 sessions 目录 —— 那底下几十个会话，全听是浪费
    watcher = watchFile(path, () => { schedule() })
  } catch (e) {
    log(`监听会话日志失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
  }
}

/**
 * 启动监听。
 *
 * 会话切换时**立刻**推一次，不等文件变化 —— 切过去看的是历史用量，
 * 那个文件可能根本不会再被写。
 */
export function start(): void {
  onSessionChange((id) => {
    rewatch(id)
    emit()
  })
  rewatch(activeSessionId())
}

/** 退出时收掉监听，别留 fd。 */
export function stop(): void {
  if (debounce !== null) { clearTimeout(debounce); debounce = null }
  watcher?.close()
  watcher = null
  watching = null
}
