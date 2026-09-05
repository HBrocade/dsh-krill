/**
 * 插件声明的 pi-ai 路线（`krill.routes`）与 `settings.yaml` 的合并 / 移除。
 *
 * 为什么路线要由插件声明：上游 llm-pi-ai 只从 `settings.yaml` 的
 * `llm-pi-ai.providers` 读路线，cordis 层叠里塞不进去。而一个网关 pack 的价值
 * 恰恰在于「按模型类型把协议、compat、UA 一次配对」—— 这些不随 pack 走，
 * 用户就得手抄一遍 YAML，抄错一个 compat 键整条路线被拒。
 *
 * 两条规则：
 *   - **同 id 已存在就不动。** 那可能是用户改过的；装个插件把人家的配置覆盖掉，
 *     比装不上更糟。报告成 kept，让面板说清楚。
 *   - **卸载只删自己声明过的 id。** 不看内容是不是还和声明一致 —— 卸载的语义
 *     就是「这条路线随插件走」。
 *
 * 这个文件不碰文件系统、不 import electron，好让 `tests/route-decls.check.ts`
 * 用纯 node 跑。文件读写在 routes.ts。
 */
import { parseDocument } from 'yaml'

export interface RouteDecl {
  /** `llm-pi-ai.providers` 下的键 */
  id: string
  /** 路线体，原样写进去；字段由上游 llm-pi-ai 的 schema 校验 */
  body: Record<string, unknown>
}

const PROVIDERS = ['llm-pi-ai', 'providers'] as const

/**
 * 解析失败必须抛。yaml 对坏文件不抛、只在 `doc.errors` 里记一笔，`toString()` 照样
 * 出字符串 —— 拿那个字符串写回去，等于把用户的坏文件再坏一次。
 */
function parseStrict(yamlText: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(yamlText)
  if (doc.errors.length > 0) {
    throw new Error(`settings.yaml 解析失败，未改动：${doc.errors[0]?.message.split('\n')[0] ?? '未知错误'}`)
  }
  return doc
}

/** 从解析好的 package.json 里取 `krill.routes`（id → 路线体 的字典）。 */
export function readRouteDecls(pkg: unknown): RouteDecl[] {
  const routes = (pkg as { krill?: { routes?: unknown } } | null | undefined)?.krill?.routes
  if (routes === null || routes === undefined || typeof routes !== 'object' || Array.isArray(routes)) return []
  return Object.entries(routes as Record<string, unknown>)
    .filter((e): e is [string, Record<string, unknown>] =>
      e[1] !== null && typeof e[1] === 'object' && !Array.isArray(e[1]))
    .map(([id, body]) => ({ id, body }))
}

export interface MergeResult {
  text: string
  added: string[]
  /** 同 id 已存在、没碰的 */
  kept: string[]
}

/**
 * 把声明的路线加进 settings.yaml 文本。用 yaml 的 Document API 增量改，
 * 用户的注释与无关段落原样保留；一条都没加时返回原文本，一个字节不变。
 */
export function mergeRouteDecls(yamlText: string, decls: readonly RouteDecl[]): MergeResult {
  const doc = parseStrict(yamlText)
  const added: string[] = []
  const kept: string[] = []
  for (const d of decls) {
    const path = [...PROVIDERS, d.id]
    if (doc.hasIn(path)) { kept.push(d.id); continue }
    doc.setIn(path, d.body)
    added.push(d.id)
  }
  return { text: added.length === 0 ? yamlText : doc.toString(), added, kept }
}

export interface RemoveResult {
  text: string
  removed: string[]
}

/** 只删给定 id；本来就没有的跳过。一条都没删时返回原文本。 */
export function removeRouteDecls(yamlText: string, ids: readonly string[]): RemoveResult {
  const doc = parseStrict(yamlText)
  const removed: string[] = []
  for (const id of ids) {
    const path = [...PROVIDERS, id]
    if (!doc.hasIn(path)) continue
    doc.deleteIn(path)
    removed.push(id)
  }
  return { text: removed.length === 0 ? yamlText : doc.toString(), removed }
}
