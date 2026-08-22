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
import type { BalanceInfo, UsageReport } from '@shared/ipc'

/** 上一次查到的余额，用来算差值。进程内保存即可 —— 跨重启的花费统计不是这个功能的目标。 */
let previous: BalanceInfo | null = null
let latest: BalanceInfo | null = null
let lastError: string | null = null

function assemble(): UsageReport {
  return {
    current: project.current(),
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
