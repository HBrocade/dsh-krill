/**
 * 读当前会话在用的模型。
 *
 * dsh 0.2.1 起，`agent-default-model` 写在 patch 层里（profile 的 `cordis.patch.yml`，
 * 以及 `$DSH_HOME/cordis.patch.yml`），不再是全局的 `~/.dsh/settings.yaml`。
 * 桥接的 headless 任务通过 overlay 拿的正是聊天那边的生效值（见 headless-overlay.ts），
 * 这里用同一套合并读出来展示给调用方看。
 */
import { chatModelConfig } from './headless-overlay.ts'

export interface CurrentModel {
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  /** 读取失败的原因；成功为 null */
  error: string | null
}

export function read(): CurrentModel {
  const empty: CurrentModel = { provider: null, model: null, reasoningEffort: null, error: null }
  try {
    // 没有任何一层设过 = 聊天里从没改过模型，两边都用 dsh-base 的默认
    const m = chatModelConfig()
    if (m === null) return empty
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
    return {
      provider: str(m['provider']),
      model: str(m['model']),
      reasoningEffort: str(m['reasoningEffort']),
      error: null,
    }
  } catch (e) {
    // buildOverlay 的报错已去掉了文件内容，可以直接显示
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 面板与 /v1/docs 都用这个短描述。 */
export function describe(): string {
  const m = read()
  if (m.error !== null) return `读取失败：${m.error}`
  if (m.provider === null || m.model === null) return 'dsh 默认模型（聊天里没改过）'
  return `${m.provider} / ${m.model}${m.reasoningEffort !== null ? `（${m.reasoningEffort}）` : ''}`
}
