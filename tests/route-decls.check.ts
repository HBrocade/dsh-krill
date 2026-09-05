import { parse } from '../node_modules/yaml/dist/index.js'
import { readRouteDecls, mergeRouteDecls, removeRouteDecls } from '../src/main/plugins/route-decls.ts'

// 一份带注释、带无关段的 settings.yaml —— 合并只能碰 llm-pi-ai.providers 下自己声明的那几条
const existing = `# 用户手写的注释，不能丢
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:
        - id: minimax-m3
permission:
  defaultPreset: danger-full-access
`

const decl = {
  id: 'agentrouter',
  body: {
    displayName: 'AgentRouter',
    api: 'anthropic-messages',
    baseURL: 'https://agentrouter.org',
    apiKeyEnv: 'AGENTROUTER_API_KEY',
    headers: { 'user-agent': 'claude-cli/2.1.20 (external, cli)' },
    models: [{ id: 'claude-opus-5', input: ['text', 'image'], compat: { supportsTemperature: true } }],
  },
}

const providersOf = (text: string): Record<string, unknown> =>
  ((parse(text) as Record<string, Record<string, unknown>>)['llm-pi-ai']?.['providers'] ?? {}) as Record<string, unknown>

const merged = mergeRouteDecls(existing, [decl])
const mergedTwice = mergeRouteDecls(merged.text, [decl])
const fromEmpty = mergeRouteDecls('', [decl])
const removed = removeRouteDecls(merged.text, ['agentrouter'])
const removedAbsent = removeRouteDecls(existing, ['agentrouter'])
const throws = (fn: () => unknown): string => {
  try { fn(); return 'no-throw' } catch (e) { return e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e) }
}
// YAML 本身坏了（比如上次手改留下没闭合的括号）：必须抛，绝不能把坏文本重新序列化写回去
const broken = 'llm-pi-ai:\n  providers: [\n'

const cases: Array<[string, unknown, unknown]> = [
  // ── 读 manifest ──
  ['krill.routes 是 id → 路线体 的字典',
    readRouteDecls({ krill: { routes: { a: { api: 'x' } } } }),
    [{ id: 'a', body: { api: 'x' } }]],
  ['没有 krill.routes 就是空',
    readRouteDecls({ krill: {} }), []],
  ['routes 不是对象就是空（数组也不认 —— id 必须是键）',
    readRouteDecls({ krill: { routes: [{ id: 'a' }] } }), []],
  ['路线体不是对象的条目跳过',
    readRouteDecls({ krill: { routes: { a: 'nope', b: { api: 'y' } } } }),
    [{ id: 'b', body: { api: 'y' } }]],

  // ── 合并 ──
  ['新路线被加进 llm-pi-ai.providers', Object.keys(providersOf(merged.text)).sort(), ['agentrouter', 'opencode-go']],
  ['路线体原样落地（headers / models 嵌套结构不变）', providersOf(merged.text)['agentrouter'], decl.body],
  ['报告 added', merged.added, ['agentrouter']],
  ['报告 kept 为空', merged.kept, []],
  ['原有路线一个字节不动', providersOf(merged.text)['opencode-go'], { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'minimax-m3' }] }],
  ['用户注释保留', merged.text.startsWith('# 用户手写的注释，不能丢'), true],
  ['无关段保留', (parse(merged.text) as Record<string, unknown>)['permission'], { defaultPreset: 'danger-full-access' }],
  ['同 id 已存在：不覆盖，文本不变', mergedTwice.text, merged.text],
  ['同 id 已存在：报告 kept', mergedTwice.kept, ['agentrouter']],
  ['同 id 已存在：added 为空', mergedTwice.added, []],
  ['空文件也能建出 llm-pi-ai.providers', providersOf(fromEmpty.text)['agentrouter'], decl.body],

  // ── 移除 ──
  ['只删自己声明的 id', Object.keys(providersOf(removed.text)), ['opencode-go']],
  ['报告 removed', removed.removed, ['agentrouter']],
  ['删的时候无关段也保留', (parse(removed.text) as Record<string, unknown>)['permission'], { defaultPreset: 'danger-full-access' }],
  ['本来就没有：removed 为空', removedAbsent.removed, []],
  ['本来就没有：文本不变', removedAbsent.text, existing],

  // ── 坏文件 ──
  ['合并时 YAML 解析失败要抛（带「解析」二字）', throws(() => mergeRouteDecls(broken, [decl])).includes('解析'), true],
  ['移除时 YAML 解析失败要抛', throws(() => removeRouteDecls(broken, ['agentrouter'])).includes('解析'), true],
]

let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`))
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
