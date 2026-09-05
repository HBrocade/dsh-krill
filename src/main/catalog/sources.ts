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
import { providerIdForHost } from './infer.ts'
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
export async function listLive(
  baseUrl: string,
  apiKey: string | null,
  headers: Readonly<Record<string, string>> = {},
): Promise<Listing> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  // 路线级 headers 两次尝试都带：按 User-Agent 放行的网关匿名也要看它
  const attempt = async (key: string | null): Promise<Response> => fetch(url, {
    headers: { ...headers, ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
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
 * 自定义路线的 models.dev 记录：路线 id 对不上就按 baseURL 的主机名找。
 * 谁都对不上返回 null —— 那这条路线的候选只能靠兜底值与族名推断。
 */
export async function modelsDevFor(routeId: string, baseURL: string | null, force = false): Promise<DevProvider | null> {
  const all = await rawModelsDev(force)
  const id = providerIdForHost(all, routeId, baseURL ?? '')
  return id === null ? null : modelsDev(id, force)
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
