/**
 * 两个外部数据源。
 *
 * **线上清单**（供应商自己的 `GET /models`）回答「现在到底能选哪些」——
 * 这是唯一权威的答案，实测 opencode-go 线上 29 个，而已装 pi-ai 目录里只有 16 个。
 * 但它只给 id，给不了协议、上下文、价格、思考档位。
 *
 * **models.dev**（opencode 自己在维护的模型元数据库）补上那些字段。它按
 * `provider.npm` 区分 SDK，能大致推出该走哪个协议 —— 只是**大致**：拿 pi-ai
 * 0.84.2 的 opencode-go 分组对了一遍，19 个里对 15 个，qwen3.7/3.8 系列和
 * minimax-m2.7 与 pi-ai 的选择相反。网关本来就多协议都能收，pi-ai 是挑了个
 * 表现最好的；我们没有那个信息，所以推断结果必须在界面上标出来，
 * 让用户自己决定要不要用。
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CatalogApi } from '@shared/ipc'

const MODELS_DEV = 'https://models.dev/api.json'
/** 4MB 的全量库，一天拉一次足够 —— 模型发布是以天计的事。 */
const TTL_MS = 24 * 60 * 60 * 1000

/** 一次列表请求的结果。失败不抛，让上层能把「这条路线没查成」如实报出来。 */
export interface Listing {
  ids: string[]
  error: string | null
}

/**
 * 拉供应商的模型清单。
 *
 * 先匿名试。opencode zen 的 `/models` 是公开的，匿名能拿到全量；被拒了再带票重试。
 * 顺序反过来的话，每查一次列表就要读一次密钥，而大多数情况根本用不上。
 */
export async function listLive(baseUrl: string, apiKey: string | null): Promise<Listing> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const attempt = async (key: string | null): Promise<Response> => fetch(url, {
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  try {
    let res = await attempt(null)
    if ((res.status === 401 || res.status === 403) && apiKey !== null) res = await attempt(apiKey)
    if (!res.ok) return { ids: [], error: `${url} 返回 ${String(res.status)}` }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((s) => s !== '')
    if (ids.length === 0) return { ids: [], error: '端点没有返回任何模型' }
    return { ids, error: null }
  } catch (e) {
    return { ids: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** models.dev 上一个模型的记录里我们用得上的部分。 */
export interface DevModel {
  name: string
  contextWindow: number | null
  maxTokens: number | null
  input: string[]
  /** `reasoning_options` 里 effort 那一组的档位名；没有可选档位时为空 */
  efforts: string[]
  /**
   * models.dev 说它会不会推理。
   *
   * 和 {@link efforts} 是两回事：有些模型一直在推理、根本不给你档位可选
   * （models.dev 上 `reasoning: true` 而 `reasoning_options` 是空的）。
   * 这种模型经过 dsh 的配置面会被判成「不推理」—— `reasoningEfforts` 是
   * 唯一能把推理打开的字段，而它要求至少一个 off 以外的档位。
   * 带出这个标记不是为了修，是为了在界面上说清楚哪几个模型掉了这项。
   */
  reasons: boolean
  /** `provider.npm`，推断协议用；缺省继承供应商级 */
  npm: string | null
}

export interface DevProvider {
  /** 供应商级端点，例如 `https://opencode.ai/zen/go/v1` */
  api: string | null
  npm: string | null
  models: Map<string, DevModel>
}

function cachePath(): string {
  return join(app.getPath('userData'), 'catalog', 'models-dev.json')
}

function probeCachePath(): string {
  return join(app.getPath('userData'), 'catalog', 'probes.json')
}

/**
 * 探测结果的缓存。
 *
 * 每发探测都是一次真实请求，要算进供应商的限额（opencode Go 的额度是按每 5 小时
 * 计次的）。检查一次十来个候选、失败的还要补打一发，不缓存的话光「看一眼」
 * 就能吃掉一小截额度。
 *
 * 只缓存**结论**，不缓存供应商的原文以外的东西；`force` 时整份丢弃重测 ——
 * 「不可用」经常是暂时的，用户点强制刷新就是想再问一次。
 */
const PROBE_TTL_MS = 6 * 60 * 60 * 1000

type ProbeCache = Record<string, { at: number; verdict: ProbeVerdict; detail: string | null }>

function readProbeCache(): ProbeCache {
  try { return JSON.parse(readFileSync(probeCachePath(), 'utf8')) as ProbeCache } catch { return {} }
}

function writeProbeCache(cache: ProbeCache): void {
  try {
    mkdirSync(dirname(probeCachePath()), { recursive: true })
    writeFileSync(probeCachePath(), JSON.stringify(cache), 'utf8')
  } catch { /* 缓存写不了只是下次多打几发，不该让检查失败 */ }
}

/** 缓存优先；过期或缺失才走网络，网络失败还有过期缓存兜底。 */
async function rawModelsDev(force: boolean): Promise<Record<string, unknown>> {
  const path = cachePath()
  let cached: { at: number; body: Record<string, unknown> } | null = null
  try {
    cached = JSON.parse(readFileSync(path, 'utf8')) as { at: number; body: Record<string, unknown> }
  } catch { /* 没缓存就去拉 */ }
  if (!force && cached !== null && Date.now() - cached.at < TTL_MS) return cached.body

  try {
    const res = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`models.dev 返回 ${String(res.status)}`)
    const body = (await res.json()) as Record<string, unknown>
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ at: Date.now(), body }), 'utf8')
    return body
  } catch (e) {
    // 拉不到就用过期缓存 —— 旧元数据也比让整次刷新失败强
    if (cached !== null) return cached.body
    throw e
  }
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/** 取一个供应商在 models.dev 上的全部记录。没有这个供应商时返回 null。 */
export async function modelsDev(provider: string, force = false): Promise<DevProvider | null> {
  const all = await rawModelsDev(force)
  const p = all[provider]
  if (p === null || typeof p !== 'object') return null
  const rec = p as Record<string, unknown>
  const rawModels = (rec['models'] !== null && typeof rec['models'] === 'object'
    ? rec['models']
    : {}) as Record<string, Record<string, unknown>>

  const models = new Map<string, DevModel>()
  for (const [id, m] of Object.entries(rawModels)) {
    const limit = (m['limit'] !== null && typeof m['limit'] === 'object' ? m['limit'] : {}) as Record<string, unknown>
    const modalities = (m['modalities'] !== null && typeof m['modalities'] === 'object'
      ? m['modalities']
      : {}) as Record<string, unknown>
    const provRec = (m['provider'] !== null && typeof m['provider'] === 'object'
      ? m['provider']
      : {}) as Record<string, unknown>
    const opts = Array.isArray(m['reasoning_options']) ? m['reasoning_options'] : []
    const effortGroup = opts.find(
      (o): o is Record<string, unknown> => o !== null && typeof o === 'object'
        && (o as Record<string, unknown>)['type'] === 'effort',
    )
    const efforts = Array.isArray(effortGroup?.['values'])
      ? (effortGroup['values'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    models.set(id, {
      name: strOrNull(m['name']) ?? id,
      contextWindow: intOrNull(limit['context']),
      maxTokens: intOrNull(limit['output']),
      input: Array.isArray(modalities['input'])
        ? (modalities['input'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
      efforts,
      reasons: m['reasoning'] === true,
      npm: strOrNull(provRec['npm']),
    })
  }
  return { api: strOrNull(rec['api']), npm: strOrNull(rec['npm']), models }
}

/**
 * 由 SDK 包名推协议。
 *
 * `@ai-sdk/openai-compatible`（多数网关的缺省）→ Chat Completions；
 * 明确写了 anthropic / openai 的分别走各自的原生协议。认不出就当 Chat Completions ——
 * 网关的通用入口就是它，猜错的代价最小。
 */
export function apiFromNpm(npm: string | null): CatalogApi {
  if (npm === '@ai-sdk/anthropic') return 'anthropic-messages'
  if (npm === '@ai-sdk/openai') return 'openai-responses'
  return 'openai-completions'
}

/**
 * 一个模型实际能不能用。
 *
 * `GET /models` 列的是**这个网关知道的型号**，不是**你现在能跑通的型号**。
 * 实测 opencode-go 线上 29 个里就有 5 个用不了：上游说 Unsupported model 的、
 * preview 期不可用的、要去后台开通数据政策的，还有一个 `ox-alpha-free` ——
 * 不带工具能聊，一带工具就 503。而 dsh 是 agent，每次调用都带工具定义，
 * 所以「能聊」在这里根本不算能用。
 *
 * pi-ai 的目录是筛过的（它自己 README 就写着只收支持 tool calling 的模型），
 * 我们从线上清单里补模型，就得自己把这道筛子补上，否则补进来的是一颗地雷：
 * 用户选了它，聊到一半报一句 `Provider finish_reason: network_error`，
 * 而那句话既不指向模型也不指向工具。
 */
export type ProbeVerdict = 'ok' | 'no-tools' | 'unavailable' | 'forbidden' | 'unknown'

export interface ProbeResult {
  verdict: ProbeVerdict
  /** 供应商自己的说法，原样截断；没有则为 null */
  detail: string | null
}

/** 一次探测请求：按协议摆出 dsh 真正会用的那种形状。 */
function probeBody(api: CatalogApi, model: string, withTools: boolean): unknown {
  if (api === 'openai-responses') {
    return {
      model, max_output_tokens: 16, input: 'hi',
      ...(withTools
        ? { tools: [{ type: 'function', name: 'noop', parameters: { type: 'object', properties: {} }, strict: false }] }
        : {}),
    }
  }
  if (api === 'anthropic-messages') {
    return {
      model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
      ...(withTools
        ? { tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } }] }
        : {}),
    }
  }
  return {
    model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }],
    ...(withTools
      ? { tools: [{ type: 'function', function: { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } } }] }
      : {}),
  }
}

function probeUrl(baseUrl: string, api: CatalogApi): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (api === 'openai-responses') return `${root}/responses`
  if (api === 'anthropic-messages') return `${root}/v1/messages`
  return `${root}/chat/completions`
}

function probeHeaders(api: CatalogApi, apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey === null) return h
  // Anthropic 协议认 x-api-key，不认 Authorization；版本头缺了会 400
  if (api === 'anthropic-messages') {
    h['x-api-key'] = apiKey
    h['anthropic-version'] = '2023-06-01'
  } else {
    h.authorization = `Bearer ${apiKey}`
  }
  return h
}

/** 供应商回的错误说明，尽量取到人能看懂的那一句。 */
function errorMessage(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string }
    const e = typeof j.error === 'object' && j.error !== null ? j.error.message : j.error
    if (typeof e === 'string' && e !== '') return e.slice(0, 200)
  } catch { /* 非 JSON 就退回原文 */ }
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed.slice(0, 200)
}

/**
 * 实测一个模型。
 *
 * 先按 dsh 的真实用法（带工具）打一发；失败了再不带工具打一发 ——
 * 这一步是为了把「模型不支持工具」和「模型压根不可用」分开。两者在界面上
 * 是完全不同的两句话，混成一句「用不了」等于把 `ox-alpha-free` 这种
 * 「能聊但当不了 agent」的情况说成故障。
 *
 * 探测本身抛异常（超时、DNS）只报 `unknown`，绝不报「不可用」——
 * 我们这边的网络问题不该让一个好模型背锅。
 */
export async function probeModel(
  args: { baseUrl: string; api: CatalogApi; model: string; apiKey: string | null },
): Promise<ProbeResult> {
  return probeOnce(args)
}

/**
 * 一批模型的实测结果，走缓存、限并发。
 *
 * 并发压到 4：这些请求要算进供应商限额，也可能各自吃满 45 秒超时，
 * 一口气全发出去既没必要也容易被限流。
 */
export async function probeModels(
  provider: string,
  items: ReadonlyArray<{ baseUrl: string; api: CatalogApi; model: string }>,
  apiKey: string | null,
  force: boolean,
): Promise<Map<string, ProbeResult>> {
  const cache = force ? {} : readProbeCache()
  const out = new Map<string, ProbeResult>()
  const todo: typeof items = items.filter((it) => {
    const hit = cache[`${provider}/${it.model}`]
    if (hit !== undefined && Date.now() - hit.at < PROBE_TTL_MS) {
      out.set(it.model, { verdict: hit.verdict, detail: hit.detail })
      return false
    }
    return true
  })

  const queue = [...todo]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const it = queue.shift()
      if (it === undefined) return
      const r = await probeOnce({ ...it, apiKey })
      out.set(it.model, r)
      cache[`${provider}/${it.model}`] = { at: Date.now(), verdict: r.verdict, detail: r.detail }
    }
  })
  await Promise.all(workers)
  if (todo.length > 0) writeProbeCache(cache)
  return out
}

async function probeOnce(
  args: { baseUrl: string; api: CatalogApi; model: string; apiKey: string | null },
): Promise<ProbeResult> {
  const send = async (withTools: boolean): Promise<{ ok: boolean; status: number; body: string }> => {
    const res = await fetch(probeUrl(args.baseUrl, args.api), {
      method: 'POST',
      headers: probeHeaders(args.api, args.apiKey),
      body: JSON.stringify(probeBody(args.api, args.model, withTools)),
      signal: AbortSignal.timeout(45_000),
    })
    return { ok: res.ok, status: res.status, body: await res.text() }
  }

  let withTools
  try { withTools = await send(true) } catch { return { verdict: 'unknown', detail: '探测请求没发出去' } }
  if (withTools.ok) {
    // 流式里 zen 会用 finish_reason 报错，非流式则不会 —— 这里 200 就算过
    return { verdict: 'ok', detail: null }
  }

  let plain
  try { plain = await send(false) } catch { plain = null }
  const detail = errorMessage(withTools.body)
  if (plain !== null && plain.ok) return { verdict: 'no-tools', detail }
  if (withTools.status === 401 || withTools.status === 403) return { verdict: 'forbidden', detail }
  if (withTools.status >= 400) return { verdict: 'unavailable', detail }
  return { verdict: 'unknown', detail }
}
