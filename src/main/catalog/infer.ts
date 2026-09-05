/**
 * 自定义路线（pi-ai 内置目录里没有的供应商）的几条推断规则。纯函数、不 import electron，
 * 好让 `tests/catalog-infer.check.ts` 用纯 node 跑。
 *
 * 目录内供应商的一切都能从目录**抄**：协议、端点、compat。自定义路线没有目录，
 * 只能推。推的结果在界面上必须标出来（`ApiSource`），推错协议不是少个功能，
 * 是发一次请求报一次错。
 */
import type { CatalogApi } from '@shared/ipc'

/** 拉 `/models` 用的 OpenAI 兼容端点：Anthropic 协议的路线 baseURL 不带 `/v1`，得补上。 */
export function listingBaseFor(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/** 某个协议的 ext 路线该用的 baseURL：Anthropic 不走 `/v1`，其余走。 */
export function extBaseUrlFor(baseURL: string, api: CatalogApi): string {
  const v1 = listingBaseFor(baseURL)
  return api === 'anthropic-messages' ? v1.replace(/\/v1$/, '') : v1
}

/**
 * 协议是怎么定的：
 *   models-dev —— models.dev 记的 SDK 包名
 *   route      —— 沿用它已经被写进的那条路线
 *   family     —— 按模型名族推（`claude-*` → Anthropic），网关级 SDK 名太笼统时用
 *   fallback   —— 什么记录都没有，按网关通用入口当 Chat Completions
 */
export type ApiSource = 'models-dev' | 'route' | 'fallback' | 'family'

/**
 * 推一个模型该走哪种协议。
 *
 * 明确的 SDK 名优先；`@ai-sdk/openai-compatible` 这种网关级的通用名等于没说，
 * 这时 `claude-*` 按族名走 Anthropic —— 网关多半两种协议都收，而 Anthropic 协议
 * 才有思考块与缓存控制。`gpt-*` 不按族名推 Responses：多数网关只转 chat/completions。
 */
export function inferApi(id: string, npm: string | null): { api: CatalogApi; source: ApiSource } {
  if (npm === '@ai-sdk/anthropic') return { api: 'anthropic-messages', source: 'models-dev' }
  if (npm === '@ai-sdk/openai') return { api: 'openai-responses', source: 'models-dev' }
  if (/^claude-/i.test(id)) return { api: 'anthropic-messages', source: 'family' }
  return { api: 'openai-completions', source: npm === null ? 'fallback' : 'models-dev' }
}

/**
 * 自定义路线上没有同协议兄弟条目可抄时的 compat 模板。
 *
 * 只给 Chat 协议：多协议网关的 chat/completions 入口普遍不认 `store`、不认 developer
 * role、只认 `max_tokens`，这三样设错会整条路线报错，设保守只是少个优化。
 * glm / deepseek 族会把思考放在 `reasoning_content` 里回，而且要求回传时带上，
 * 不设 deepseek 式思考格式就是「有思考却读不到、下一轮 400」。
 * Anthropic / Responses 协议的默认值本来就对，不套模板。
 */
export function defaultCompat(id: string, api: CatalogApi): Record<string, string | boolean> {
  if (api !== 'openai-completions') return {}
  const base: Record<string, string | boolean> = {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  }
  return /^(glm|deepseek)/i.test(id)
    ? { ...base, thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true }
    : base
}

/**
 * 自定义路线在 models.dev 里对应哪个供应商：先按路线 id，再按 baseURL 的主机名。
 * 用户给路线起的名字多半和 models.dev 的 id 不一样（`my-relay`），主机名才是稳的。
 */
export function providerIdForHost(
  all: Readonly<Record<string, unknown>>,
  routeId: string,
  baseURL: string,
): string | null {
  const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  if (isRec(all[routeId])) return routeId
  let host: string
  try {
    host = new URL(baseURL).host.toLowerCase()
  } catch {
    return null
  }
  for (const [id, p] of Object.entries(all)) {
    if (!isRec(p) || typeof p['api'] !== 'string') continue
    try {
      if (new URL(p['api']).host.toLowerCase() === host) return id
    } catch { /* 这条记录的 api 不是 URL，跳过 */ }
  }
  return null
}
