/**
 * 从会话事件投影出「谁花了多少 token」。
 *
 * 数据本身是精确的 —— token 数来自 provider 响应里的 `usage`，dsh 原样记进日志。
 * 模型归属也不用猜：`assistant/message` 这一个事件里**同时**有
 * `data.usage` 与 `data.message.source.model`，实测和流式 `usage` chunk 逐字段相同。
 *
 * （先写过一版按 seq 把 usage chunk 和后面的 message 配对，多余且脆弱 —— 一个
 * 事件里本来就都有。）
 *
 * 特意不在这里算钱。DeepSeek 有峰谷价（北京时间 9-12、14-18 为高峰，低谷是五折）、
 * 三个模型、三类 token，单价表是我们唯一维护不住的东西 —— 它会在我们不知情时过期，
 * 然后给出一个看起来精确的错数字。金额用余额差另算，那个一分钱都不会错。
 */
import { readEvents, listSessions, type SessionEvent, type SessionFile } from './session-log.ts'
import type { ModelUsage, SessionUsage } from '@shared/ipc'

interface RawUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

interface AssistantMessageData {
  usage?: RawUsage
  message?: { source?: { model?: unknown; provider?: unknown } }
}

/** 从一条 `assistant/message` 里取出「供应商 + 模型 + 用量」；不是这类事件返回 null。 */
function readTurn(e: SessionEvent): { provider: string; model: string; usage: RawUsage } | null {
  if (e.type !== 'assistant/message') return null
  const d = e.data as AssistantMessageData | undefined
  if (d?.usage === undefined) return null
  const model = d.message?.source?.model
  const provider = d.message?.source?.provider
  return {
    provider: typeof provider === 'string' ? provider : '(未知)',
    model: typeof model === 'string' ? model : '(未知模型)',
    usage: d.usage,
  }
}

function emptyModelUsage(model: string, provider = '—'): ModelUsage {
  return {
    model,
    provider,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

/** 投影一个会话：把每条 assistant/message 的用量按模型累加。 */
export function projectSession(file: SessionFile): SessionUsage {
  const events = readEvents(file.path)
  const byModel = new Map<string, ModelUsage>()
  let firstAt: number | null = null
  let lastAt: number | null = null

  for (const e of events) {
    if (typeof e.time === 'number') {
      firstAt ??= e.time
      lastAt = e.time
    }
    const turn = readTurn(e)
    if (turn === null) continue
    // 按「供应商 + 模型」分组：同名模型经不同路由的价格与账户都不同
    const key = `${turn.provider}/${turn.model}`
    const m = byModel.get(key) ?? emptyModelUsage(turn.model, turn.provider)
    m.calls += 1
    m.inputTokens += turn.usage.inputTokens ?? 0
    m.outputTokens += turn.usage.outputTokens ?? 0
    m.cacheReadTokens += turn.usage.cacheReadTokens ?? 0
    m.reasoningTokens += turn.usage.reasoningTokens ?? 0
    byModel.set(key, m)
  }

  const models = [...byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens)
  return {
    id: file.id,
    workspace: file.workspace,
    updatedAt: file.mtimeMs,
    firstEventAt: firstAt,
    lastEventAt: lastAt,
    models,
    totals: models.reduce((acc, m) => ({
      model: '合计',
      provider: '—',
      calls: acc.calls + m.calls,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      reasoningTokens: acc.reasoningTokens + m.reasoningTokens,
    }), emptyModelUsage('合计')),
  }
}

/**
 * 最近若干个会话的用量。
 *
 * 只读最近的几个：一份会话日志两百多万字节、两千多个 zstd 帧，全量扫会很慢，
 * 而右栏要的是「最近在花什么」，不是全部历史。
 */
export function recent(limit = 8): SessionUsage[] {
  return listSessions().slice(0, limit).map(projectSession)
}

/**
 * 按 id 找会话文件。
 *
 * 目录名有两种写法并存：新的是 `session-<uuid>`（和 RPC 里的 sessionId 一致），
 * 老会话是裸 `<uuid>`。两种都认，否则老对话会显示成「没有用量记录」。
 */
export function findById(sessionId: string): SessionFile | null {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return listSessions().find((f) => f.id === sessionId || f.id === bare) ?? null
}

/**
 * 当前会话。
 *
 * 优先用 SPA 正在打开的那个（旁听 RPC 得来）；拿不到才退回「最后写入的」——
 * 后者在「切到旧对话但没发消息」时是错的，那个文件那时根本没被写过。
 */
export function current(activeId: string | null): SessionUsage | null {
  if (activeId !== null) {
    const f = findById(activeId)
    if (f !== null) return projectSession(f)
  }
  const [newest] = listSessions()
  return newest === undefined ? null : projectSession(newest)
}
