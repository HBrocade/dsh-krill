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
import { readEventsFrom, listSessions, type SessionEvent, type SessionFile } from './session-log.ts'
import type { ModelUsage, SessionUsage } from '@shared/ipc'

/**
 * DeepSeek 官方路由的 provider id。
 *
 * 取自上游 `packages/llm/llm-deepseek/src/index.ts` 里的 `const PROVIDER`。
 * 只有这条路由的消耗会扣 DeepSeek 账户余额。
 */
export const OFFICIAL_PROVIDER = 'deepseek-official'

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
    official: provider === OFFICIAL_PROVIDER,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

/**
 * 每个会话的累加状态。
 *
 * 会话日志只会追加，所以不必每次重头解：记住「已消费到第几字节」和当前累计值，
 * 下次只处理新增的那几帧。开销于是与新数据量成正比，与文件多大无关 ——
 * 一个 7.4MB 的会话全量解要 618ms，而它正在被写时每次追加都会让按 mtime 做的
 * 缓存失效，流式回答期间就成了每 600ms 卡半秒多。
 */
interface Accumulated {
  consumed: number
  byModel: Map<string, ModelUsage>
  firstAt: number | null
  lastAt: number | null
}
const accumulated = new Map<string, Accumulated>()

/** 投影一个会话：把每条 assistant/message 的用量按模型累加。 */
export function projectSession(file: SessionFile): SessionUsage {
  let acc = accumulated.get(file.path)
  if (acc === undefined) {
    acc = { consumed: 0, byModel: new Map(), firstAt: null, lastAt: null }
    accumulated.set(file.path, acc)
  }

  // 文件比记录的还短 = 被重写或换了会话，之前的累计作废
  if (file.sizeBytes < acc.consumed) {
    acc = { consumed: 0, byModel: new Map(), firstAt: null, lastAt: null }
    accumulated.set(file.path, acc)
  }

  if (file.sizeBytes > acc.consumed) {
    const { events, consumed } = readEventsFrom(file.path, acc.consumed)
    acc.consumed = consumed
    for (const e of events) {
      if (typeof e.time === 'number') {
        acc.firstAt ??= e.time
        acc.lastAt = e.time
      }
      const turn = readTurn(e)
      if (turn === null) continue
      // 按「供应商 + 模型」分组：同名模型经不同路由的价格与账户都不同
      const key = `${turn.provider}/${turn.model}`
      const m = acc.byModel.get(key) ?? emptyModelUsage(turn.model, turn.provider)
      m.calls += 1
      m.inputTokens += turn.usage.inputTokens ?? 0
      m.outputTokens += turn.usage.outputTokens ?? 0
      m.cacheReadTokens += turn.usage.cacheReadTokens ?? 0
      m.reasoningTokens += turn.usage.reasoningTokens ?? 0
      acc.byModel.set(key, m)
    }
  }

  const models = [...acc.byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens)
  return {
    id: file.id,
    workspace: file.workspace,
    updatedAt: file.mtimeMs,
    firstEventAt: acc.firstAt,
    lastEventAt: acc.lastAt,
    models,
    totals: models.reduce((t, m) => ({
      model: '合计',
      provider: '—',
      official: false,
      calls: t.calls + m.calls,
      inputTokens: t.inputTokens + m.inputTokens,
      outputTokens: t.outputTokens + m.outputTokens,
      cacheReadTokens: t.cacheReadTokens + m.cacheReadTokens,
      reasoningTokens: t.reasoningTokens + m.reasoningTokens,
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
 * 知道是哪个会话时就**只认那个**：找不到对应的日志文件说明它还没产生任何用量
 * （刚建的新会话就是这样），该显示「没有记录」，而不是退回去显示别的会话。
 *
 * 退回「最后写入的」只在**从未观察到会话 id** 时才成立 —— 那是刚启动、
 * 用户还没在界面上动过任何东西的场景。之前无条件兜底，导致新建会话时右栏
 * 显示的是上一个对话的数字，看着像统计错了。
 */
export function current(activeId: string | null): SessionUsage | null {
  if (activeId !== null) {
    const f = findById(activeId)
    return f === null ? null : projectSession(f)
  }
  const [newest] = listSessions()
  return newest === undefined ? null : projectSession(newest)
}
