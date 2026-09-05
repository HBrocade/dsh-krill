import { listingBaseFor, extBaseUrlFor, inferApi, providerIdForHost, defaultCompat } from '../src/main/catalog/infer.ts'

/**
 * 自定义路线（不在 pi-ai 内置目录里的）也要能查线上列表、按协议拆路线。
 * 这里是那几条纯推断规则；文件读写与网络在 index.ts / sources.ts。
 */
const modelsDev = {
  agentrouter: { api: 'https://agentrouter.org/v1', npm: '@ai-sdk/openai-compatible' },
  'opencode-go': { api: 'https://opencode.ai/zen/go/v1', npm: '@ai-sdk/openai-compatible' },
  anthropic: { api: 'https://api.anthropic.com/v1', npm: '@ai-sdk/anthropic' },
  broken: 'not-an-object',
  noapi: { npm: '@ai-sdk/openai' },
}

const cases: Array<[string, unknown, unknown]> = [
  // ── 拉列表用哪个端点：OpenAI 兼容的 /models，Anthropic 协议的路线 baseURL 不带 /v1 也得补上 ──
  ['baseURL 不带 /v1 → 补上', listingBaseFor('https://agentrouter.org'), 'https://agentrouter.org/v1'],
  ['baseURL 已带 /v1 → 原样', listingBaseFor('https://agentrouter.org/v1'), 'https://agentrouter.org/v1'],
  ['末尾斜杠去掉再判', listingBaseFor('https://agentrouter.org/v1/'), 'https://agentrouter.org/v1'],
  ['本机 Ollama 也一样', listingBaseFor('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1'],

  // ── ext 路线的 baseURL：Anthropic 协议不走 /v1，其余走 ──
  ['Anthropic 协议从带 /v1 的源推出不带的', extBaseUrlFor('https://agentrouter.org/v1', 'anthropic-messages'), 'https://agentrouter.org'],
  ['Anthropic 协议源本来就不带 → 原样', extBaseUrlFor('https://agentrouter.org', 'anthropic-messages'), 'https://agentrouter.org'],
  ['Chat 协议从不带 /v1 的源补上', extBaseUrlFor('https://agentrouter.org', 'openai-completions'), 'https://agentrouter.org/v1'],
  ['Responses 协议同样带 /v1', extBaseUrlFor('https://agentrouter.org/', 'openai-responses'), 'https://agentrouter.org/v1'],

  // ── 协议推断：模型名族优先于网关级的通用 SDK 名；明确的 SDK 名照旧 ──
  ['claude-* 在通用网关上 → Anthropic 协议（族名优先）',
    inferApi('claude-opus-5', '@ai-sdk/openai-compatible'), { api: 'anthropic-messages', source: 'family' }],
  ['claude-* 连 models.dev 记录都没有 → 仍按族名',
    inferApi('claude-opus-4-8', null), { api: 'anthropic-messages', source: 'family' }],
  ['models.dev 明确说 anthropic SDK → 以它为准',
    inferApi('some-model', '@ai-sdk/anthropic'), { api: 'anthropic-messages', source: 'models-dev' }],
  ['models.dev 明确说 openai SDK → Responses',
    inferApi('gpt-5.6', '@ai-sdk/openai'), { api: 'openai-responses', source: 'models-dev' }],
  ['gpt-* 在通用网关上 → Chat（网关多半只转 chat/completions）',
    inferApi('gpt-5.6-sol', '@ai-sdk/openai-compatible'), { api: 'openai-completions', source: 'models-dev' }],
  ['其他模型没记录 → Chat 兜底',
    inferApi('glm-5.3', null), { api: 'openai-completions', source: 'fallback' }],

  // ── 自定义路线在 models.dev 里找供应商：先按 id，再按 baseURL 的主机名 ──
  ['路线 id 直接命中', providerIdForHost(modelsDev, 'agentrouter', 'https://agentrouter.org'), 'agentrouter'],
  ['id 不命中，按主机名对上', providerIdForHost(modelsDev, 'my-relay', 'https://agentrouter.org'), 'agentrouter'],
  ['主机名比较忽略端口以外的路径与协议大小写', providerIdForHost(modelsDev, 'x', 'HTTPS://opencode.ai/zen/go'), 'opencode-go'],
  ['谁都对不上 → null', providerIdForHost(modelsDev, 'x', 'http://127.0.0.1:11434/v1'), null],
  ['坏记录不炸', providerIdForHost(modelsDev, 'broken', 'https://nowhere.test'), null],
  ['baseURL 不是合法 URL → null', providerIdForHost(modelsDev, 'x', 'not a url'), null],

  // ── 自定义路线没有同协议兄弟条目可抄时的 compat 模板 ──
  ['Chat 协议的通用网关模板：不发 store、不用 developer role、用 max_tokens',
    defaultCompat('gpt-5.6-sol', 'openai-completions'),
    { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' }],
  ['glm / deepseek 族会回 reasoning_content，模板加上 deepseek 式思考格式',
    defaultCompat('glm-5.3', 'openai-completions'),
    { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true }],
  ['deepseek-* 同上', defaultCompat('deepseek-v4-flash', 'openai-completions')['thinkingFormat'], 'deepseek'],
  ['Anthropic 协议不需要模板', defaultCompat('claude-opus-5', 'anthropic-messages'), {}],
  ['Responses 协议不需要模板', defaultCompat('gpt-5.6', 'openai-responses'), {}],
]

let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`))
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
