/**
 * 插件管理编排:状态、事件广播、刷新。
 * 变更动作（安装/卸载/禁用/体检）在 manage.ts。
 */
import * as inventory from './inventory.ts'
import * as manage from './manage.ts'
import * as patch from './patch.ts'
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

export async function install(
  args: { spec: string; channel: 'injected' | 'official' },
): Promise<import('@shared/ipc').InstallOutcome> {
  const outcome = await manage.install(args)
  await refresh()
  return outcome
}

export async function uninstall(args: { name: string }): Promise<string> {
  const report = await manage.uninstall(args)
  // 标记为待卸载：清理已做完，但运行中的 fiber 还在，重启才真正生效
  pending.add(args.name)
  await refresh()
  const failed = report.steps.filter((s) => !s.ok)
  const summary = report.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.label}：${s.detail}`).join('\n')
  return failed.length === 0
    ? `已清理四处残留，重启后端后生效。\n${summary}`
    : `清理完成但有 ${failed.length} 处未成功，重启前请先看：\n${summary}`
}

export async function setDisabled(args: { name: string; disabled: boolean }): Promise<string> {
  const msg = manage.setDisabled(args)
  await refresh()
  return msg
}

export async function patchDoctor(args: { fix: boolean }): Promise<import('@shared/ipc').PatchHealth> {
  const profile = state.patchHealth.profile || 'web'
  const result = args.fix ? patch.heal(profile) : patch.inspect(profile)
  await refresh()
  return result
}

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
