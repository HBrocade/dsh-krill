/**
 * 读当前会话在用的模型。
 *
 * dsh 的 `agent-default-model` 与凭据都放在 **全局** `~/.dsh/`，
 * 各 profile 继承同一份 —— 也就是说桥接跑的 headless 任务，
 * 天然就在用你聊天时那个模型和那把 key，不需要额外配置或传参。
 * 这里只负责把它读出来展示给调用方看。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'yaml'

export interface CurrentModel {
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  /** 读取失败的原因；成功为 null */
  error: string | null
}

export function read(): CurrentModel {
  const file = join(homedir(), '.dsh', 'settings.yaml')
  const empty: CurrentModel = { provider: null, model: null, reasoningEffort: null, error: null }
  if (!existsSync(file)) return { ...empty, error: '~/.dsh/settings.yaml 不存在' }
  try {
    const doc = parse(readFileSync(file, 'utf8')) as {
      'agent-default-model'?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    } | null
    const m = doc?.['agent-default-model']
    if (m === undefined) return { ...empty, error: 'settings.yaml 里没有 agent-default-model' }
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
    return {
      provider: str(m.provider),
      model: str(m.model),
      reasoningEffort: str(m.reasoningEffort),
      error: null,
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 面板与 /v1/docs 都用这个短描述。 */
export function describe(): string {
  const m = read()
  if (m.error !== null) return `读取失败：${m.error}`
  if (m.provider === null || m.model === null) return '未配置默认模型'
  return `${m.provider} / ${m.model}${m.reasoningEffort !== null ? `（${m.reasoningEffort}）` : ''}`
}
