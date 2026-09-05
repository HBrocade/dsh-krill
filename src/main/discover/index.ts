/**
 * 插件检索：拿已配置路线的 key，问模型「有哪些插件能做这件事」，把回答存下来。
 *
 * 为什么问模型而不是查 npm：想装的东西通常是用**能力**描述的（「让它能看图」、
 * 「接飞书」），而 npm 的搜索只认关键词。代价是模型会编包名 —— 所以这里做两件事：
 * 每条结果都带模型自报的把握，模型的原文一个字不改地留着。界面上给的是「可复制
 * 的候选」，不是「可以直接装的清单」，安装仍然要人自己把包名贴进安装框。
 *
 * 只发 OpenAI 兼容的 `/chat/completions`：三家网关都收这条，而为了问一句话
 * 再写一套 Anthropic 报文不值当。路线怎么推出来的见 catalog/index.ts 的 chatRoutes。
 */
import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from '../backend/log-ring.ts'
import { chatRoutes, routeKey } from '../catalog/index.ts'
import * as store from './store.ts'
import type { DiscoverHit, DiscoverRecord, DiscoverRoute, DiscoverState } from '@shared/ipc'

/** 一次问话给 120 秒。带思考的模型开口前先想两分钟是常事。 */
const TIMEOUT_MS = 120_000

const SYSTEM = [
  '你在帮人给 dsh（DeepSeek Harness，基于 cordis 的插件体系）找插件。',
  '用户用「我想要什么能力」的方式提需求，你要给出可能可用的 npm 包。',
  '',
  '规则：',
  '- 只列你确实见过的包。凭印象拼出来的包名把 confidence 标成 low，并在 note 里说清楚这是猜的。',
  '- 一个都想不起来就回空的 hits，不要凑数。凑出来的包名会让人白装一遍。',
  '- 这个生态的包名前缀通常是 @deepseek-ai/dsh-、dsh-plugin-、cordis-plugin-、koishi-plugin-。',
  '- 只输出 JSON，不要 markdown 代码块，不要任何解释文字。形状：',
  '{"hits":[{"name":"包名","summary":"一句话说明它做什么","install":"安装用的 spec，通常等于包名",',
  '"homepage":"主页或仓库地址，不知道填 null","confidence":"high|medium|low","note":"补充说明，没有填 null"}]}',
].join('\n')

/**
 * 存档懒加载。
 *
 * 不在模块顶层读：这个模块在 app ready 之前就被 import 进来了，而存档路径要问
 * `app.getPath('userData')`。晚一步读没有任何代价 —— 第一次要用它的时候
 * 一定已经 ready 了。
 */
let records: DiscoverRecord[] | null = null
function all(): DiscoverRecord[] {
  records ??= store.load()
  return records
}
let searching = false
let error: string | null = null

const listeners = new Set<(s: DiscoverState) => void>()

export function onChange(fn: (s: DiscoverState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function routes(): DiscoverRoute[] {
  try {
    return chatRoutes().map((r): DiscoverRoute => ({
      id: r.id,
      displayName: r.id,
      hasKey: r.hasKey,
      models: r.models,
    }))
  } catch (e) {
    log(`插件检索：列路线失败 ${e instanceof Error ? e.message : String(e)}`, 'stderr')
    return []
  }
}

export function getState(): DiscoverState {
  return {
    routes: routes(),
    records: structuredClone(all()),
    searching,
    storePath: store.storePath(),
    error,
  }
}

function emit(): void {
  const snap = getState()
  for (const fn of listeners) {
    try { fn(snap) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

/** 重新读盘。用户手改过存档、或另一个窗口写过，靠这个对齐。 */
export function reload(): DiscoverState {
  records = store.load()
  error = null
  emit()
  return getState()
}

export function remove(args: { id: string }): DiscoverState {
  records = store.save(all().filter((r) => r.id !== args.id))
  emit()
  return getState()
}

/**
 * 从模型回答里抠出那份 JSON。
 *
 * 说了「只输出 JSON」也照样有模型给你包一层代码块、或在前面写句「好的」。
 * 所以先剥围栏，再取第一个 `{` 到最后一个 `}` —— 抠不出来不是错误，
 * 原文照样存，界面上让人自己看。
 */
function parseHits(raw: string): DiscoverHit[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const body = fenced?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const list = (parsed as { hits?: unknown } | null)?.hits
  if (!Array.isArray(list)) return []
  const out: DiscoverHit[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = typeof r['name'] === 'string' ? r['name'].trim() : ''
    if (name === '') continue
    const str = (k: string): string | null => {
      const v = r[k]
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
    }
    out.push({
      name,
      summary: str('summary') ?? '',
      install: str('install') ?? name,
      homepage: str('homepage'),
      confidence: r['confidence'] === 'high' || r['confidence'] === 'low' ? r['confidence'] : 'medium',
      note: str('note'),
    })
  }
  return out
}

/** 兼容两种 content：字符串，和 OpenAI 新版的分段数组。 */
function readContent(message: Record<string, unknown> | undefined): string {
  const content = message?.['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      const p = part as Record<string, unknown> | null
      return typeof p?.['text'] === 'string' ? p['text'] : ''
    })
    .join('')
}

/**
 * 发一次问话。
 *
 * 报文刻意只带 model + messages：temperature / max_tokens 这些在不同网关上的
 * 兼容开关各不相同（settings.yaml 里那一堆 compat 就是为它们准备的），
 * 为了问一句话而踩中其中一个，不如一个都不带。
 */
async function ask(baseUrl: string, key: string | null, model: string, query: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: query },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // 带上响应体的头一段：401 和「模型名写错了」都是这个状态码，光看数字分不出来
    const detail = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`${url} 返回 ${String(res.status)}${detail === '' ? '' : `：${detail}`}`)
  }
  const body = (await res.json()) as { choices?: Array<{ message?: Record<string, unknown> }> }
  const text = readContent(body.choices?.[0]?.message).trim()
  if (text === '') throw new Error('模型返回了空回答')
  return text
}

export async function search(args: { routeId: string; model: string; query: string }): Promise<DiscoverRecord> {
  const query = args.query.trim()
  if (query === '') throw new Error('先说清楚要找什么样的插件')
  const route = chatRoutes().find((r) => r.id === args.routeId)
  if (route === undefined) throw new Error(`路线 ${args.routeId} 不在可用列表里 —— 它没有可用的 OpenAI 兼容端点`)
  const model = args.model.trim() === '' ? (route.models[0] ?? '') : args.model.trim()
  if (model === '') throw new Error(`路线 ${args.routeId} 一个模型都没有`)

  searching = true
  error = null
  emit()
  const record: DiscoverRecord = {
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: Date.now(),
    query,
    routeId: route.id,
    model,
    hits: [],
    raw: '',
    error: null,
  }
  try {
    record.raw = await ask(route.baseUrl, routeKey(route), model, query)
    record.hits = parseHits(record.raw)
    log(`插件检索：${route.id}/${model} 回了 ${String(record.hits.length)} 条候选`)
  } catch (e) {
    // 失败也存档。存的是「这条路线这个模型问不通」，下次不用再撞一次
    record.error = e instanceof Error ? e.message : String(e)
    error = record.error
    log(`插件检索失败：${record.error}`, 'stderr')
  } finally {
    searching = false
  }
  records = store.save([record, ...all()])
  emit()
  return structuredClone(record)
}

/**
 * 在文件管理器里指出存档。
 *
 * 一次都没检索过时文件还不存在，`showItemInFolder` 对不存在的路径是**静默无事
 * 发生** —— 那种情况下退而打开所在目录，至少让人看见它该在哪儿。
 */
export async function revealStore(): Promise<void> {
  const path = store.storePath()
  if (existsSync(path)) { shell.showItemInFolder(path); return }
  await shell.openPath(dirname(path))
}
