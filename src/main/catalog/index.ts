/**
 * 模型目录刷新。
 *
 * 要解决的现象：opencode 上新出的模型，在 dsh 的模型选择器里根本挑不到。
 *
 * 成因是两层叠加，跟 dsh 本身没关系：
 *   1. 「可选模型列表」来自 `@earendil-works/pi-ai` 里一份**静态生成**的目录快照，
 *      dsh 把 pi-ai 钉在 `^0.82.1`，装的就是 0.82.1；
 *   2. 就算把 pi-ai 顶到最新，那份快照本身也落后于供应商线上 ——
 *      实测 opencode-go 线上 29 个模型，pi-ai 0.82.1 收了 16 个、0.84.2 收了 19 个。
 * 而 dsh 的 discovery 对目录内供应商**不发网络请求**，所以界面上永远刷不出来。
 *
 * 这个模块绕过快照：直接问供应商「你现在有哪些」，把目录里没有的补成
 * 声明式路线写进 `settings.yaml`。只处理**配了 key 的**路线 —— 没配 key 的
 * 供应商，把它的模型列出来也选不了，徒增噪音。
 */
import { log } from '../backend/log-ring.ts'
import * as installed from './installed.ts'
import * as sources from './sources.ts'
import {
  API_LABEL, extRouteId, hasCredential, readCredential, readOfficialRoute, readRoutes, writePlan,
} from './settings.ts'
import { defaultCompat, extBaseUrlFor, inferApi, listingBaseFor } from './infer.ts'
import type { ExtRoutePlan, RouteConfig } from './settings.ts'
import type {
  CatalogApi, CatalogCandidate, CatalogModelRef, CatalogReport, CatalogRoute,
} from '@shared/ipc'

/**
 * 允许写进配置的 compat 开关。
 *
 * dsh 把 pi-ai 的 compat 字段分成 offer / withhold 两类，withhold 的写在任何地方
 * 都会让整条路线被拒（那些是「官方目录已经替你设好」的字段）。这份名单是 offer
 * 那一侧的子集：只留能从同协议的兄弟条目原样抄过来、且是纯标量的。
 * 抄不动的（chatTemplateKwargs 这种带结构的）宁可不带 —— 少一个开关是行为退化，
 * 带错一个是整条路线起不来。
 */
const COMPAT_ALLOW: Record<CatalogApi, readonly string[]> = {
  'openai-completions': [
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'maxTokensField', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
    'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
    'supportsStrictMode', 'cacheControlFormat', 'supportsLongCacheRetention',
  ],
  'openai-responses': ['supportsDeveloperRole', 'supportsStrictMode', 'supportsLongCacheRetention'],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools',
    'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
  ],
}

/** dsh 认得的思考档位。models.dev 报了别的名字就丢掉，写进去会被整条拒掉。 */
const LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 目录里没描述的模型的兜底容量。只在 models.dev 也查不到时用得上。 */
const FALLBACK_CONTEXT = 128_000
const FALLBACK_MAX_TOKENS = 16_384

const empty: CatalogReport = {
  checkedAt: null, checking: false, available: false,
  piAiVersion: null, routes: [], error: null,
}

let report: CatalogReport = empty
/**
 * 正在跑的那次检查。
 *
 * 并发调用要**等它**，而不是拿一份过期快照走人 —— 后者会让「写完配置立刻复查」
 * 读到写之前的状态，看着像写入没生效。实测就踩到了这个。
 */
let inFlight: Promise<CatalogReport> | null = null
const listeners = new Set<(r: CatalogReport) => void>()

export function getReport(): CatalogReport { return structuredClone(report) }

export function onChange(fn: (r: CatalogReport) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function patch(next: Partial<CatalogReport>): void {
  report = { ...report, ...next }
  const snapshot = getReport()
  for (const fn of listeners) {
    try { fn(snapshot) } catch { /* 一个订阅者出错不该影响别人 */ }
  }
}

/** 当前 dsh 入口，由主进程在装配时注入 —— 这个模块不该自己去碰 supervisor。 */
let resolveBin: () => string | null = () => null
export function bindLocator(fn: () => string | null): void { resolveBin = fn }

/** 同协议的兄弟条目怎么设 compat，新条目就怎么设 —— 取众数，不取第一个。 */
function siblingCompat(models: readonly installed.InstalledModel[], api: CatalogApi): Record<string, string | boolean> {
  const votes = new Map<string, Map<string, number>>()
  for (const m of models) {
    if (m.api !== api) continue
    for (const [k, v] of Object.entries(m.compat)) {
      if (!COMPAT_ALLOW[api].includes(k)) continue
      if (typeof v !== 'string' && typeof v !== 'boolean') continue
      const key = JSON.stringify(v)
      const bucket = votes.get(k) ?? new Map<string, number>()
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
      votes.set(k, bucket)
    }
  }
  const out: Record<string, string | boolean> = {}
  for (const [field, bucket] of votes) {
    let best: string | null = null
    let bestN = 0
    for (const [v, n] of bucket) if (n > bestN) { best = v; bestN = n }
    if (best !== null) out[field] = JSON.parse(best) as string | boolean
  }
  return out
}

/** 同协议的兄弟条目用哪个 baseUrl，新条目就用哪个 —— 这是抄来的，不是猜的。 */
function siblingBaseUrl(models: readonly installed.InstalledModel[], api: CatalogApi): string | null {
  for (const m of models) if (m.api === api && m.baseUrl !== '') return m.baseUrl
  return null
}

/** models.dev 供应商级端点的兜底：Anthropic 协议不走 `/v1`，其余走。 */
function fallbackBaseUrl(devApi: string | null, api: CatalogApi): string | null {
  if (devApi === null) return null
  return api === 'anthropic-messages' ? devApi.replace(/\/v1\/?$/, '') : devApi
}

/**
 * 自定义路线自己声明的模型，装成目录条目的形状 —— 兄弟 compat / 协议归组那套逻辑
 * 就能原样复用。它们对这条路线而言就是「目录」：用户手写的全部。
 */
function ownModels(route: RouteConfig): installed.InstalledModel[] {
  const api = knownApi(route.api)
  return route.modelEntries.flatMap((e): installed.InstalledModel[] => {
    const id = typeof e['id'] === 'string' ? e['id'] : ''
    if (id === '') return []
    const compat = e['compat'] !== null && typeof e['compat'] === 'object'
      ? (e['compat'] as Record<string, unknown>)
      : {}
    return [{ id, name: typeof e['name'] === 'string' ? e['name'] : id, api, baseUrl: route.baseURL ?? '', compat }]
  })
}

function buildCandidate(
  id: string,
  dev: sources.DevModel | undefined,
  siblings: readonly installed.InstalledModel[],
  custom: boolean,
): CatalogCandidate {
  // 目录路线按 models.dev 的 SDK 名推；自定义路线多一层族名规则（claude-* → Anthropic），
  // 因为网关级的 SDK 名多半是笼统的 openai-compatible
  const inferred = custom
    ? inferApi(id, dev?.npm ?? null)
    : { api: sources.apiFromNpm(dev?.npm ?? null), source: dev === undefined ? 'fallback' as const : 'models-dev' as const }
  const api = inferred.api
  const efforts: Record<string, string | null> = {}
  for (const level of dev?.efforts ?? []) {
    if (LEVELS.includes(level)) efforts[level] = level
  }
  // 只有 off 一档等于没档位，dsh 会直接拒掉；这种情况当作「不推理」
  const usable = Object.keys(efforts).some((l) => l !== 'off')
  const input = (dev?.input ?? ['text']).filter((m): m is 'text' | 'image' => m === 'text' || m === 'image')
  // compat 优先抄同协议的兄弟条目；自定义路线上没有兄弟可抄时套协议模板，
  // 目录路线则宁可不带（目录里本来就该有兄弟，没有说明这个协议在这条路线上是新的）
  const sibling = siblingCompat(siblings, api)
  return {
    id,
    name: dev?.name ?? id,
    api,
    apiSource: inferred.source,
    contextWindow: dev?.contextWindow ?? FALLBACK_CONTEXT,
    maxTokens: dev?.maxTokens ?? FALLBACK_MAX_TOKENS,
    input: input.length > 0 ? input : ['text'],
    reasoningEfforts: usable ? efforts : null,
    reasonsWithoutLevels: !usable && (dev?.reasons ?? false),
    compat: custom && Object.keys(sibling).length === 0 ? defaultCompat(id, api) : sibling,
    described: dev !== undefined,
  }
}

/** 一条路线的检查结果。失败不抛 —— 一条路线查不成不该拖垮其余几条。 */
async function inspectRoute(
  cat: installed.InstalledCatalog,
  route: ReturnType<typeof readRoutes>[number],
  declared: readonly CatalogModelRef[],
  force: boolean,
): Promise<CatalogRoute> {
  const base: CatalogRoute = {
    id: route.id,
    displayName: route.id,
    hasKey: hasCredential(route.apiKeyEnv),
    apiKeyEnv: route.apiKeyEnv,
    inCatalog: installed.hasProvider(cat, route.id),
    catalog: [], catalogKept: [], hasModelOverrides: route.hasModelOverrides,
    installedCount: 0, liveCount: 0, declared: [...declared],
    candidates: [], error: null,
  }
  if (!base.hasKey) return base

  // 自定义路线没有目录，它手写的 models 就是它的「目录」
  const custom = !base.inCatalog
  const models = custom ? ownModels(route) : installed.readProvider(cat, route.id)
  base.installedCount = models.length
  base.catalog = models
    .map((m): CatalogModelRef => ({ id: m.id, name: m.name, api: m.api }))
    .sort((a, b) => a.id.localeCompare(b.id))
  // 原路线写了 models: 就以那份清单为准，否则整份目录都在服务
  // —— 后者是唯一能跟随目录更新的状态，别把它物化成一份全量清单
  base.catalogKept = route.modelIds.length > 0
    ? route.modelIds.filter((id) => models.some((m) => m.id === id))
    : base.catalog.map((m) => m.id)

  // 拉线上列表用哪个端点、元数据去哪查，两类路线来源不同：
  //   目录路线 —— 端点抄目录里 Chat 协议兄弟的，models.dev 按供应商 id 查；
  //   自定义路线 —— 端点从它自己的 baseURL 推（补 /v1），models.dev 先按 id 再按主机名找。
  let listingBase: string | null
  let dev: sources.DevProvider | null
  if (custom) {
    if (route.baseURL === null) {
      base.error = '自定义路线没有 baseURL，无从拉线上列表'
      return base
    }
    listingBase = listingBaseFor(route.baseURL)
    dev = await sources.modelsDevFor(route.id, route.baseURL, force).catch(() => null)
  } else {
    dev = await sources.modelsDev(route.id, force).catch(() => null)
    listingBase = siblingBaseUrl(models, 'openai-completions')
      ?? fallbackBaseUrl(dev?.api ?? null, 'openai-completions')
    if (listingBase === null) {
      base.error = '找不到可以拉列表的 OpenAI 兼容端点'
      return base
    }
  }

  const listing = await sources.listLive(listingBase, readCredential(route.apiKeyEnv), route.headers)
  if (listing.error !== null) { base.error = listing.error; return base }
  base.liveCount = listing.ids.length

  const known = new Set(models.map((m) => m.id))
  const already = new Set(declared.map((d) => d.id))
  base.candidates = listing.ids
    .filter((id) => !known.has(id) && !already.has(id))
    .map((id) => buildCandidate(id, dev?.models.get(id), models, custom))
    .sort((a, b) => a.id.localeCompare(b.id))
  return base
}

/**
 * 已经被我们写进配置的模型，按源路线归拢。
 *
 * 它们不该再算作「缺」，同时也是穿梭框右侧的初始内容 —— 右侧代表的是
 * 「这条路线最终要有哪些补充模型」，而不是「这次新加了哪些」，所以它一开始
 * 就该等于配置里现在的样子。
 */
function declaredByRoute(): Map<string, CatalogModelRef[]> {
  const out = new Map<string, CatalogModelRef[]>()
  for (const r of readRoutes()) {
    if (!r.isExt || r.extOf === null) continue
    const api = knownApi(r.api)
    const list = out.get(r.extOf) ?? []
    for (const entry of r.modelEntries) {
      const id = typeof entry['id'] === 'string' ? entry['id'] : ''
      if (id === '') continue
      list.push({ id, name: typeof entry['name'] === 'string' ? entry['name'] : id, api })
    }
    out.set(r.extOf, list)
  }
  return out
}

export function refresh(options: { force?: boolean } = {}): Promise<CatalogReport> {
  if (inFlight !== null) return inFlight
  const run = runRefresh(options)
  inFlight = run
  return run.finally(() => { inFlight = null })
}

async function runRefresh(options: { force?: boolean }): Promise<CatalogReport> {
  patch({ checking: true, error: null })
  try {
    const cat = installed.locateCatalog(resolveBin())
    if (cat === null) {
      patch({ checking: false, available: false, checkedAt: Date.now(), routes: [], error: '定位不到 dsh 用的那份 pi-ai' })
      return getReport()
    }
    const declared = declaredByRoute()
    // 只看用户自己写在配置里的源路线：ext 路线是我们的产物，不是检查对象
    const routes = readRoutes().filter((r) => !r.isExt)
    const results = await Promise.all(
      routes.map((r) => inspectRoute(cat, r, declared.get(r.id) ?? [], options.force ?? false)),
    )
    const missing = results.reduce((n, r) => n + r.candidates.length, 0)
    log(`模型目录：检查完成，pi-ai ${cat.version ?? '?'}，${String(routes.length)} 条路线，${String(missing)} 个新模型`)
    patch({
      checking: false, available: true, checkedAt: Date.now(),
      piAiVersion: cat.version, routes: results, error: null,
    })
  } catch (e) {
    patch({ checking: false, checkedAt: Date.now(), error: e instanceof Error ? e.message : String(e) })
  }
  return getReport()
}

/** 把一个候选序列化成 settings.yaml 里的一条 models 条目。 */
function toEntry(c: CatalogCandidate): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens,
    input: [...c.input],
    ...(c.reasoningEfforts === null ? {} : { reasoningEfforts: c.reasoningEfforts }),
    ...(Object.keys(c.compat).length === 0 ? {} : { compat: c.compat }),
  }
}

function knownApi(v: string | null): CatalogApi {
  return v === 'anthropic-messages' || v === 'openai-responses' ? v : 'openai-completions'
}

/**
 * 让这条路线最终服务 `modelIds` 里的那些模型。
 *
 * 传进来的是**全集**，不是增量。两半分开落地，因为机制根本不同：
 *
 *   - **目录自带的**：写一份保留清单到原路线的 `models:`。dsh 没有黑名单只有白名单，
 *     去掉一个就得把其余的列出来。清单里光写 id 就行 —— 协议、容量、价格、compat、
 *     思考档位全从目录条目继承，实测一个字段都不丢。
 *     一个都没去掉时**删掉这个键**而不是写全量清单，那是唯一还能跟随目录更新的状态。
 *   - **目录外的**：按协议各开一条 ext 路线，见 settings.ts 顶部。
 *     上一轮写进去的条目原样搬过来，不重新推一遍 —— 重推会把名字、容量、思考档位
 *     退回兜底值，用户明明只挪了一个模型，其余条目却悄悄变差了。
 *
 * @returns 最终服务的模型总数
 */
export async function apply(args: { routeId: string; modelIds: string[] }): Promise<number> {
  const routes = readRoutes()
  const route = routes.find((r) => r.id === args.routeId)
  if (route === undefined) throw new Error(`配置里没有路线 ${args.routeId}`)
  if (route.apiKeyEnv === null) throw new Error(`路线 ${args.routeId} 没有 apiKeyEnv，声明式路线必须有凭据引用`)

  const cat = installed.locateCatalog(resolveBin())
  if (cat === null) throw new Error('定位不到 dsh 用的那份 pi-ai')
  const custom = !installed.hasProvider(cat, args.routeId)
  if (custom && route.baseURL === null) throw new Error(`自定义路线 ${args.routeId} 没有 baseURL，推不出拆分路线该用的端点`)
  const models = custom ? ownModels(route) : installed.readProvider(cat, args.routeId)
  const catalogIds = new Set(models.map((m) => m.id))

  const wanted = new Set(args.modelIds)
  const keptCatalog = models.map((m) => m.id).filter((id) => wanted.has(id))
  if (catalogIds.size > 0 && keptCatalog.length === 0) {
    throw new Error(custom
      ? `${args.routeId} 至少得留一个自己声明的模型：自定义路线的模型只能来自它的 models 清单，清空等于整条路线没模型`
      : `${args.routeId} 至少得留一个目录自带的模型：dsh 把空的 models 读成「没写」，`
        + '写下去反而会恢复整份目录 —— 与你的意图正相反')
  }
  if (keptCatalog.length < catalogIds.size && route.hasModelOverrides) {
    throw new Error(
      `${args.routeId} 写了 modelOverrides，它与 models 互斥 —— 去掉目录里的模型必须写 models 清单，`
      + '两者同时存在会让 dsh 拒掉整条路线。先把 modelOverrides 挪成 models 条目上的字段',
    )
  }
  const sourceList = keptCatalog.map((id) => {
    // 用户手写过的条目原样留着（可能带 maxTokens 之类的自定义），其余只写 id
    const own = route.modelEntries.find((e) => e['id'] === id)
    return own ?? { id }
  })
  // 目录路线全留着就把 models 键删掉：写一份全量清单等于把这条路线钉死在今天的目录上。
  // 自定义路线永远写数组：它的 models 是手写的全部，删键就是删光。
  const sourceModels = custom || keptCatalog.length < catalogIds.size ? sourceList : null
  // 自定义路线上，和它同协议的新模型直接进它自己的 models（路线级 api 对整条生效），
  // 不用另开一条同协议的拆分路线
  const sourceApi = knownApi(route.api)

  const grouped = new Map<CatalogApi, Array<Record<string, unknown>>>()
  const push = (api: CatalogApi, entry: Record<string, unknown>): void => {
    grouped.set(api, [...(grouped.get(api) ?? []), entry])
  }
  // 先搬已经补进去的：它们的元数据只有当初那次检查算得出来
  const seen = new Set<string>()
  for (const ext of routes.filter((r) => r.extOf === args.routeId)) {
    for (const entry of ext.modelEntries) {
      const id = typeof entry['id'] === 'string' ? entry['id'] : ''
      if (id === '' || !wanted.has(id) || seen.has(id) || catalogIds.has(id)) continue
      seen.add(id)
      push(knownApi(ext.api), entry)
    }
  }
  // 再是这次新挪过去的
  for (const c of report.routes.find((r) => r.id === args.routeId)?.candidates ?? []) {
    if (!wanted.has(c.id) || seen.has(c.id) || catalogIds.has(c.id)) continue
    seen.add(c.id)
    if (custom && c.api === sourceApi) sourceList.push(toEntry(c))
    else push(c.api, toEntry(c))
  }

  const ext: ExtRoutePlan[] = []
  for (const [api, list] of grouped) {
    // 目录路线抄同协议兄弟的端点；自定义路线从自己的 baseURL 推（Anthropic 不带 /v1，其余带）
    const baseURL = custom ? extBaseUrlFor(route.baseURL ?? '', api) : siblingBaseUrl(models, api)
    if (baseURL === null) {
      throw new Error(`路线 ${args.routeId} 的目录里没有 ${api} 协议的模型，推不出该用哪个 baseURL`)
    }
    ext.push({
      source: args.routeId,
      api,
      displayName: custom
        ? `${args.routeId}（${API_LABEL[api]} 协议）`
        : `${args.routeId}（目录外·${API_LABEL[api]}）`,
      baseURL,
      apiKeyEnv: route.apiKeyEnv,
      // 网关按 User-Agent 放行的话，拆出去的路线不带同样的头就是一条永远 401 的路线
      ...(Object.keys(route.headers).length > 0 ? { headers: route.headers } : {}),
      models: list,
    })
  }

  const { added } = writePlan({ source: args.routeId, sourceModels, ext })
  // 等复查跑完再返回：界面拿到的提示语和随后推过去的报告出自同一次读盘，
  // 不会出现「提示说写了 15 个、列表还是写之前的样子」
  await refresh()
  return (custom ? sourceList.length : keptCatalog.length) + added
}

/**
 * 撤回这条路线上的一切改动：ext 路线删掉；目录路线恢复成全量服务，
 * 自定义路线的 models 不碰 —— 那是用户手写的全部，删键等于删光。
 */
export async function clear(args: { routeId: string }): Promise<number> {
  const cat = installed.locateCatalog(resolveBin())
  // 定位不到目录时也按自定义处理：'keep' 永远不会删掉任何东西
  const custom = cat === null || !installed.hasProvider(cat, args.routeId)
  const before = readRoutes().filter((r) => r.extOf === args.routeId)
  writePlan({ source: args.routeId, sourceModels: custom ? 'keep' : null, ext: [] })
  await refresh()
  return before.reduce((n, r) => n + r.modelIds.length, 0)
}

/**
 * 一条能拿来直接发 chat completions 的路线 —— 插件检索用的。
 *
 * 与 {@link CatalogRoute} 的区别见 ipc.ts 里 DiscoverRoute 的注释。这里只回
 * OpenAI 兼容的那一面：`/chat/completions` 三家网关都收，而 Anthropic 协议的
 * 路线要另写一套报文，为了问一句话不值当。
 */
export interface ChatRoute {
  id: string
  apiKeyEnv: string | null
  hasKey: boolean
  baseUrl: string
  models: string[]
}

/**
 * 列出所有推得出 OpenAI 兼容端点的路线。
 *
 * baseURL 三种来源，优先级从确凿到推断：配置里写死的 > 已装目录里同路线
 * openai-completions 条目上的 > 没有就放弃这条路线（宁可不列，也不猜一个
 * 发出去 404 的地址）。ext 路线一并列出 —— 它们本来就是声明式的、baseURL
 * 写在配置里，是最稳的那一档。
 */
export function chatRoutes(): ChatRoute[] {
  const cat = installed.locateCatalog(resolveBin())
  // 官方那条排头：它不在 providers 段里（归 llm-deepseek 独占），
  // 按 providers 遍历永远遍历不到它 —— 见 settings.ts 的 readOfficialRoute
  const official = readOfficialRoute()
  const out: ChatRoute[] = [{
    id: official.id,
    apiKeyEnv: official.apiKeyEnv,
    hasKey: hasCredential(official.apiKeyEnv),
    baseUrl: official.baseURL,
    models: official.modelIds,
  }]
  for (const route of readRoutes()) {
    const models = cat === null ? [] : installed.readProvider(cat, route.id)
    const baseUrl = route.baseURL ?? siblingBaseUrl(models, 'openai-completions')
    if (baseUrl === null) continue
    const ids = new Set<string>(route.modelIds)
    for (const m of models) if (m.api === 'openai-completions') ids.add(m.id)
    if (ids.size === 0) continue
    out.push({
      id: route.id,
      apiKeyEnv: route.apiKeyEnv,
      hasKey: hasCredential(route.apiKeyEnv),
      baseUrl,
      models: [...ids].sort((a, b) => a.localeCompare(b)),
    })
  }
  return out
}

/** 取某条路线的票。值只往它自己的供应商发 —— 不落日志、不进 IPC。 */
export function routeKey(route: ChatRoute): string | null {
  return readCredential(route.apiKeyEnv)
}

export { extRouteId }
