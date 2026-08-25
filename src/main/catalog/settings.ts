/**
 * 读写 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 段。
 *
 * 为什么新模型只能靠**另开一条路线**，不能直接补进原路线：
 * dsh 的 `resolveRouteModels` 里，一个 models 条目**不带 api 字段** ——
 * 已在目录里的模型用目录记的 api，目录没有的则退回「整条路线的模型共用的那个 api」，
 * 而共用 api 只在路线上所有模型 api 一致时才存在（`sharedCatalogApi`：`apis.size === 1`）。
 * opencode-go 恰好横跨 anthropic-messages / openai-completions / openai-responses 三种，
 * 于是新模型无处安放：唯一能指定协议的是**路线级** `api:`，而它会盖掉路线上每一个模型，
 * 把那些走别的协议的现有模型一并搞坏。
 *
 * 所以按协议各开一条声明式路线，原路线一个字节都不动。代价是模型选择器里多出
 * 一到三个供应商分组 —— 这是**故意**的：这些条目的元数据是推断来的，
 * 跟官方目录里那些混在一起反而是隐瞒。
 *
 * 反过来，把**目录里自带**的模型从选择器里去掉，只能动原路线：dsh 没有黑名单，
 * 只有白名单 —— `models:` 一写就**替换**整份目录，留下的就是清单里那些。
 * 好在清单里光写 `id` 不丢任何东西：协议、容量、价格、compat、思考档位全部从
 * 目录条目继承（`...base` 展开），实测三种协议混排的 opencode-go 一个字段都没变。
 *
 * 有两个坑：
 *   - `models: []` **不等于**「一个都不要」。schema 把缺省的 models 物化成 `[]`，
 *     所以空清单会被读成「没写」，反而恢复整份目录。清空必须在写之前拦下来。
 *   - 写了 `models:` 这条路线就**不再跟随目录更新**了 —— 以后 pi-ai 补了新模型，
 *     它不会自己冒出来。所以「一个都没去掉」时要把这个键删掉，而不是写一份全量清单。
 *
 * 另外，这里只写 `settings.yaml`，绝不去动已装的 pi-ai 包。改 node_modules 里那份
 * 目录 JSON 看着更干净，但内嵌的那棵树在 `.app/Contents/Resources` 里 —— 签名后
 * 改了就坏签名 —— 而且 dsh 一升级就是 `npm install --prefix` 覆盖整棵树，改动全没。
 * 配置文件两样都不沾。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseDocument } from 'yaml'
import { log } from '../backend/log-ring.ts'
import type { CatalogApi } from '@shared/ipc'

/** dsh 家目录。`DSH_HOME` 优先 —— 与 dsh 自己的解析顺序保持一致。 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function settingsPath(): string { return join(dshHome(), 'settings.yaml') }

/**
 * 我们生成的路线的 id 形如 `<源路线>--ext-<协议简称>`。
 *
 * 不另存一份清单，就靠 id 认自己的产物：清单会和文件本身失同步（用户手改了
 * settings.yaml 之后清单还当那条路线是自己的），而 id 就写在被改的那个文件里，
 * 永远同步。双连字符是为了不和真实供应商 id 撞上。
 */
const EXT_MARK = '--ext-'

const API_SUFFIX: Record<CatalogApi, string> = {
  'anthropic-messages': 'msgs',
  'openai-completions': 'chat',
  'openai-responses': 'resp',
}

const API_LABEL: Record<CatalogApi, string> = {
  'anthropic-messages': 'Anthropic',
  'openai-completions': 'Chat',
  'openai-responses': 'Responses',
}

export function extRouteId(source: string, api: CatalogApi): string {
  return `${source}${EXT_MARK}${API_SUFFIX[api]}`
}

/** 一条路线在配置里的样子 —— 只取我们判断得上的那几项。 */
export interface RouteConfig {
  id: string
  /** 凭据引用名（`apiKeyEnv`）；没写为 null */
  apiKeyEnv: string | null
  /** 路线级 api；只有声明式路线才有 */
  api: string | null
  baseURL: string | null
  /** 配置里显式列出的模型 id —— 这些不算「缺」 */
  modelIds: string[]
  /**
   * 这些条目的原样。
   *
   * 重新应用时**原样搬过去**，不重新推一遍：ext 路线是整条替换的，而候选的
   * 元数据只在「检查」那一刻算得出来。拿不到就重推的话，一次「取消勾选某个模型」
   * 会把其余每个条目的名字、容量、思考档位统统退回兜底值 —— 用户什么也没改，
   * 配置却悄悄变差了。
   */
  modelEntries: Array<Record<string, unknown>>
  /**
   * 这条路线写了 `modelOverrides`。
   *
   * 它和 `models` 互斥（dsh 会直接拒掉整条路线），所以一旦有它，
   * 「去掉目录里的模型」这件事就做不了 —— 得在界面上说清楚，而不是写下去再报错。
   */
  hasModelOverrides: boolean
  /** 是不是我们生成的那种路线 */
  isExt: boolean
  /** 是我们生成的话，源路线是谁 */
  extOf: string | null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** 读出 `llm-pi-ai.providers` 下的每一条路线。文件读不出来就当没有配置。 */
export function readRoutes(): RouteConfig[] {
  let raw: Record<string, unknown>
  try {
    const doc = parseDocument(readFileSync(settingsPath(), 'utf8'))
    const node = doc.getIn(['llm-pi-ai', 'providers']) as { toJSON?: () => unknown } | undefined
    if (node === undefined) return []
    const obj = typeof node.toJSON === 'function' ? node.toJSON() : node
    if (obj === null || typeof obj !== 'object') return []
    raw = obj as Record<string, unknown>
  } catch {
    return []
  }

  return Object.entries(raw).map(([id, value]): RouteConfig => {
    const v = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const models = (Array.isArray(v['models']) ? v['models'] : [])
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    const idx = id.indexOf(EXT_MARK)
    return {
      id,
      apiKeyEnv: asString(v['apiKeyEnv']),
      api: asString(v['api']),
      baseURL: asString(v['baseURL']),
      modelIds: models.map((m) => asString(m['id'])).filter((s): s is string => s !== null),
      modelEntries: models,
      hasModelOverrides: v['modelOverrides'] !== null && typeof v['modelOverrides'] === 'object',
      isExt: idx > 0,
      extOf: idx > 0 ? id.slice(0, idx) : null,
    }
  })
}

/**
 * 这个凭据引用有没有值。
 *
 * 三处都算数，因为 dsh 自己就是这么找的（inherited env > `.credentials.yaml` >
 * `.env`）。**只看键在不在，不读值** —— 判断「配没配 key」用不着知道 key 是什么。
 */
export function hasCredential(ref: string | null): boolean {
  if (ref === null) return false
  const fromEnv = process.env[ref]
  if (fromEnv !== undefined && fromEnv !== '') return true
  if (credentialFromStore(ref) !== null) return true
  const dotenv = join(dshHome(), '.env')
  if (existsSync(dotenv)) {
    try {
      return new RegExp(`^\\s*(export\\s+)?${ref}\\s*=`, 'm').test(readFileSync(dotenv, 'utf8'))
    } catch { /* 读不动就当没有；这里的答案只影响要不要去刷这条路线 */ }
  }
  return false
}

/**
 * 从 `.credentials.yaml` 取一条 ref。
 *
 * 文档是 `version: 1` + `refs:` 两层，**不是**平铺的 —— 平铺是预发布期的旧布局，
 * dsh 0.1.1 起会拒绝并要求迁移（用户目录里那个
 * `.credentials.yaml.bak-0.1.1-layout-*` 就是迁移留下的）。这里两种都认：
 * 只认新布局的话，还没迁的机器上「配了 key」会被判成没配，而现象是
 * 面板一声不吭地跳过整条路线 —— 最难查的那种。
 *
 * 另有一个 `records:` 段，装的是 OAuth 之类的记录，按 `<scope>/<id>` 编址；
 * 路线上的 `apiKeyEnv` 是 ref 不是 record，不在那儿找。
 */
function credentialFromStore(ref: string): string | null {
  const path = join(dshHome(), '.credentials.yaml')
  if (!existsSync(path)) return null
  try {
    const doc = parseDocument(readFileSync(path, 'utf8'))
    const nested = doc.getIn(['refs', ref])
    if (typeof nested === 'string' && nested !== '') return nested
    // 旧的平铺布局：顶层直接就是 ref → 值
    if (doc.get('version') === undefined) {
      const flat = doc.get(ref)
      if (typeof flat === 'string' && flat !== '') return flat
    }
  } catch { /* 读不动 / 解析不了就当没有 */ }
  return null
}

/**
 * 取凭据的**值**。只在一种情况下调用：供应商的模型列表端点拒绝了匿名请求。
 *
 * 判断「配没配 key」用 {@link hasCredential} 就够，那条路径不碰值。这里之所以
 * 还是要读，是因为拉列表本身就得带票 —— 而这正是这个 key 存在的用途。
 * 值只往它自己的供应商发，不落日志、不进 IPC。
 */
export function readCredential(ref: string | null): string | null {
  if (ref === null) return null
  const fromEnv = process.env[ref]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return credentialFromStore(ref)
}

/**
 * dsh 自带的那条官方路线（`deepseek-official`）。
 *
 * 它**不在** `llm-pi-ai.providers` 里 —— 那段是 pi-ai 的声明式路线，而官方这条
 * 归 `llm-deepseek` 插件独占（它自己的 `PROVIDER = "deepseek-official"`）。
 * 所以按 providers 段列路线时它一条都不会出现，界面上看着就像「不支持官方」。
 *
 * 三项都跟着那个插件的解析顺序来：
 *   apiKeyEnv —— `llm-deepseek.apiKeyEnv`，缺省 `DEEPSEEK_API_KEY`
 *   baseURL   —— 配置 > `$DEEPSEEK_BASE_URL` > 公网默认 `https://api.deepseek.com`
 *   models    —— `llm-deepseek.models`，缺省就是插件里那两条
 * 端点形状也一样（`${baseURL}/chat/completions`），所以拿它发问话不用特殊分支。
 */
export interface OfficialRoute {
  id: string
  apiKeyEnv: string
  baseURL: string
  modelIds: string[]
}

const OFFICIAL_ID = 'deepseek-official'
const OFFICIAL_DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

export function readOfficialRoute(): OfficialRoute {
  const fallback: OfficialRoute = {
    id: OFFICIAL_ID,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // 环境变量为空串等于没设 —— 空 baseURL 拼出来的是个发不出去的地址
    baseURL: asString(process.env['DEEPSEEK_BASE_URL']) ?? 'https://api.deepseek.com',
    modelIds: [...OFFICIAL_DEFAULT_MODELS],
  }
  const path = settingsPath()
  if (!existsSync(path)) return fallback
  let section: unknown
  try {
    section = parseDocument(readFileSync(path, 'utf8')).toJS() as Record<string, unknown>
    section = (section as Record<string, unknown>)['llm-deepseek']
  } catch {
    // 读不动就用缺省：这条路线的三项全都有插件级默认值，缺配置是常态而非故障
    return fallback
  }
  if (section === null || typeof section !== 'object') return fallback
  const v = section as Record<string, unknown>
  const models = (Array.isArray(v['models']) ? v['models'] : [])
    .map((m) => (m !== null && typeof m === 'object' ? asString((m as Record<string, unknown>)['id']) : null))
    .filter((s): s is string => s !== null)
  return {
    id: OFFICIAL_ID,
    apiKeyEnv: asString(v['apiKeyEnv']) ?? fallback.apiKeyEnv,
    baseURL: asString(v['baseURL']) ?? fallback.baseURL,
    modelIds: models.length > 0 ? models : fallback.modelIds,
  }
}

/** 写入前先备份。settings.yaml 里还有凭据引用与模型默认值，写坏了 dsh 起不来。 */
function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-catalog-${String(Date.now())}`)
}

export interface ExtRoutePlan {
  source: string
  api: CatalogApi
  displayName: string
  baseURL: string
  apiKeyEnv: string
  /** 已经序列化好的 models 条目 —— 见 {@link RouteConfig.modelEntries} */
  models: Array<Record<string, unknown>>
}

/**
 * 一次落地：原路线的保留清单 + 若干条 ext 路线，一起写。
 *
 * 合成一次是有意的 —— 两件事都改同一个文件，分两次写就是两次解析、两次备份，
 * 中间还有一个「ext 已经写了但原路线还没改」的半成品状态留在盘上。
 *
 * 用 yaml 的 Document API 增量改，不整份重写：这个文件用户手改过，
 * 整份重写等于把他写的注释和格式一并抹掉。
 */
export interface WritePlan {
  /** 源路线 id —— 同时决定清理哪些旧 ext 路线 */
  source: string
  /**
   * 写给**原路线**的 `models:` 列表；`null` = 删掉这个键。
   *
   * 删键而不是写全量清单，是为了让「一个都没去掉」的路线继续跟随目录更新。
   * 空数组这里不接受 —— 它会被 dsh 读成「没写」，恢复整份目录，
   * 与调用方的意图正好相反，所以在 {@link writePlan} 里直接抛。
   */
  sourceModels: Array<Record<string, unknown>> | null
  ext: readonly ExtRoutePlan[]
}

export function writePlan(plan: WritePlan): { kept: number; added: number } {
  if (plan.sourceModels !== null && plan.sourceModels.length === 0) {
    throw new Error('保留清单不能为空：空的 models 会被读成「没写」，反而恢复整份目录')
  }
  const path = settingsPath()
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '')
  backup(path)

  const keep = new Set(plan.ext.map((p) => extRouteId(p.source, p.api)))
  for (const route of readRoutes()) {
    if (!route.isExt || route.extOf !== plan.source) continue
    if (keep.has(route.id)) continue
    doc.deleteIn(['llm-pi-ai', 'providers', route.id])
    log(`模型目录：移除路线 ${route.id}`)
  }

  let added = 0
  for (const p of plan.ext) {
    const id = extRouteId(p.source, p.api)
    // 整条 value 换掉而不是逐字段 setIn：一条 ext 路线是我们全权生成的，
    // 上一轮留下的模型如果只 set 不换，会和这一轮的混在一起。
    doc.setIn(['llm-pi-ai', 'providers', id], {
      displayName: p.displayName,
      api: p.api,
      baseURL: p.baseURL,
      apiKeyEnv: p.apiKeyEnv,
      models: p.models,
    })
    added += p.models.length
    log(`模型目录：写入路线 ${id}（${String(p.models.length)} 个模型）`)
  }

  const modelsPath = ['llm-pi-ai', 'providers', plan.source, 'models']
  if (plan.sourceModels === null) {
    if (doc.hasIn(modelsPath)) {
      doc.deleteIn(modelsPath)
      log(`模型目录：${plan.source} 恢复为服务整份目录（删掉 models 清单）`)
    }
  } else {
    doc.setIn(modelsPath, plan.sourceModels)
    log(`模型目录：${plan.source} 保留目录里的 ${String(plan.sourceModels.length)} 个模型`)
  }

  writeFileSync(path, doc.toString(), 'utf8')
  return { kept: plan.sourceModels?.length ?? 0, added }
}

export { API_LABEL }
