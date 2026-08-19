/**
 * 插件管理编排:状态、事件广播、刷新。
 * 变更动作（安装/卸载/禁用/体检）在 manage.ts。
 */
import * as inventory from './inventory.ts'
import { log } from '../backend/log-ring.ts'
import type { PluginsState } from '@shared/ipc'

let state: PluginsState = {
  injectorAvailable: false,
  restartRequired: false,
  entries: [],
  patchHealth: { profile: 'web', path: '', duplicateIds: [], orphanDisabled: [], parseError: null },
}

const listeners = new Set<(s: PluginsState) => void>()
let inFlight: Promise<PluginsState> | null = null

export function getState(): PluginsState { return structuredClone(state) }

export function onChange(fn: (s: PluginsState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit(): void {
  const snap = getState()
  for (const fn of listeners) {
    try { fn(snap) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

/** 标记为待卸载/待禁用的包，重启后才真正生效 —— 跨刷新保留。 */
const pending = new Set<string>()

export function markPending(name: string): void { pending.add(name); void refresh() }
export function clearPending(name: string): void { pending.delete(name); void refresh() }

export function refresh(): Promise<PluginsState> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    const next = await inventory.collect()
    for (const e of next.entries) {
      if (pending.has(e.name)) { e.pendingRemoval = true; next.restartRequired = true }
    }
    state = next
    emit()
    return getState()
  })().catch((e: unknown) => {
    log(`插件清单读取失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
    return getState()
  }).finally(() => { inFlight = null })
  return inFlight
}
