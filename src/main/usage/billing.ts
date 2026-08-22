/**
 * 按会话记账。
 *
 * 每个会话记住「第一次看到它时的余额」，之后的差值就是这个会话开着的期间账户
 * 少掉的钱。切回某个会话时看到的是它自己的数字，而不是一个全局的「上次到现在」。
 *
 * **这不是精确的会话成本。** 余额是账户级的：同时开着的另一个会话、桥接跑的
 * 一次性任务、甚至别处用同一个账号，花的钱都会算进来。它的真实含义是
 * 「这个会话开着的这段时间，账户少了多少」。
 *
 * 只记走过 DeepSeek 官方路由的会话 —— 别家路由的消耗根本不经这个账户。
 */
import { log } from '../backend/log-ring.ts'
import type { BalanceInfo, SessionBilling } from '@shared/ipc'

const ledger = new Map<string, SessionBilling>()

export function count(): number { return ledger.size }

export function get(sessionId: string | null): SessionBilling | null {
  return sessionId === null ? null : ledger.get(sessionId) ?? null
}

/**
 * 把一次余额查询记到某个会话名下。
 *
 * 第一次见到这个会话就把当前余额存成基准；之后每次刷新只更新 latest 与差值。
 *
 * @param sessionId - 当前会话；为 null（还没认出会话）时什么都不记，
 *   免得把余额挂到一个说不清是谁的条目上
 */
export function record(sessionId: string | null, balance: BalanceInfo): void {
  if (sessionId === null) return
  const existing = ledger.get(sessionId)
  if (existing === undefined) {
    ledger.set(sessionId, {
      sessionId,
      currency: balance.currency,
      openingBalance: balance.total,
      latestBalance: balance.total,
      spent: 0,
      openedAt: balance.at,
      updatedAt: balance.at,
    })
    return
  }
  ledger.set(sessionId, {
    ...existing,
    currency: balance.currency,
    latestBalance: balance.total,
    // 充值会让余额变多，差值成负 —— 如实呈现，不夹逼到 0：
    // 显示成 0 会让人以为「没花钱」，而实际是「期间充过值」
    spent: existing.openingBalance - balance.total,
    updatedAt: balance.at,
  })
}

/**
 * 清掉已经不存在的会话。
 *
 * 会话可以在界面上删除或归档，它的账留着只是长期占内存，而且会在用户重新
 * 用到同一个 id 时给出一个横跨很久的、毫无意义的差值。
 *
 * @param exists - 判断某个会话现在还在不在
 * @returns 清掉的条数
 */
export function prune(exists: (sessionId: string) => boolean): number {
  let removed = 0
  for (const id of [...ledger.keys()]) {
    if (exists(id)) continue
    ledger.delete(id)
    removed += 1
  }
  if (removed > 0) log(`清理了 ${String(removed)} 个已不存在会话的计费记录`)
  return removed
}
