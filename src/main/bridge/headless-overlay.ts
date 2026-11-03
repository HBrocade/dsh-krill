/**
 * 桥接 headless 任务的 `--patch` 覆盖层。
 *
 * dsh 0.2.1 起有两处变化，把桥接「零配置、和聊天用同一份」的前提打破了：
 *
 *   · headless bundle 自带 `credentials` / `authorization` / `deepseek-account`
 *     三行 disabled（见 dsh-headless README「凭据」节），于是既读不到「模型」页
 *     存的 API key，也读不到平台登录 —— 任务一启动就 `MISSING_CREDENTIAL`。
 *   · 模型选择从全局 `~/.dsh/settings.yaml` 挪进了各 profile 的 `cordis.patch.yml`。
 *     headless 的 patch 是空的，于是它跑 dsh-base 的默认模型，不再跟着聊天走。
 *
 * 所以每次任务前，按 dsh 的层序算出聊天那边模型路由相关几行的生效值，再加上
 * 恢复存储认证的几行，写成一份 overlay 交给 `--patch`。用户的 `~/.dsh` 一个字节不动。
 */
import { app } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Document, YAMLError, YAMLMap, YAMLSeq, isMap, isNode, isSeq, parse, parseDocument } from 'yaml'
import { dshHome } from '../catalog/settings.ts'

/** 聊天用的 profile —— 与 supervisor 启动的那个保持一致。 */
export const CHAT_PROFILE = 'web'

/**
 * 从聊天那边抄过来的行：模型选择、各条模型路由、平台账号。
 *
 * 只抄 `config` 与 `disabled`，**不抄 `name`**：旧版 patch 里可能还留着上一代的
 * 插件名（比如 `llm-deepseek` 指向 `@deepseek-ai/dsh-llm-deepseek`），抄过去会把
 * headless 自己挂的那个插件换掉。这几个 id 都由 dsh-base 挂载，headless 一定有。
 *
 * `deepseek-account` 必须跟着抄：账号插件启动时，如果已存授权的签发方和
 * `platformOrigin` 对不上，会**直接删掉本地登录**。聊天那边若改过
 * `platformOrigin`，headless 用默认值一启动就会把用户登出。
 */
const SYNC_IDS: ReadonlySet<string> = new Set([
  'agent-default-model',
  'llm-pi-ai',
  'llm-deepseek',
  'llm-deepseek-account',
  'deepseek-account',
])

/** headless bundle 关掉、而桥接一定要用的两行。 */
const FORCE_ENABLE = ['credentials', 'authorization'] as const

/**
 * 账号插件：聊天那边没表态就打开（base 默认就是开的，headless bundle 才关它），
 * 表态了就照抄 —— 聊天停用了它，桥接就不该成为唯一一个拿共享凭据库做签发方校验的进程。
 */
const ACCOUNT_ID = 'deepseek-account'

export interface PatchSource {
  /** 报错时用来指明是哪个文件 */
  label: string
  text: string
}

/**
 * 只报错误码和行号，**绝不带 message**：yaml 的 prettyErrors 会把出错行和上下文
 * 原样嵌进 message，而 patch 里合法地放着路由 headers、部署 cookie。这条报错会
 * 经 HTTP 回给调用方（另一个 AI），也会显示在面板上。
 */
function brief(label: string, e: unknown): string {
  if (e instanceof YAMLError) {
    const line = e.linePos?.[0].line
    return `${label} 解析失败（${e.code}${line !== undefined ? `，第 ${String(line)} 行` : ''}）`
  }
  return `${label} 解析失败`
}

/**
 * 生成 overlay 文本。纯函数，便于单独验证。
 *
 * `sources` 按 dsh 的层序给：web profile 的 patch 在前，`$DSH_HOME/cordis.patch.yml`
 * 在后（dsh-app-boot `readProfilePatches`：bundles → profile → home → `--patch`）。
 * patch 对一行的 `config` 是整段替换、不合并，所以按 (id, 键) 后者覆盖前者，
 * 得到的就是聊天那边的生效值。home 层对 headless 本来也生效，但 overlay 排在它后面，
 * 不把它算进来就会被 profile 层的旧值盖掉。
 *
 * 走 YAML 文档树而不是「parse → 对象 → stringify」：patch 里允许 `!!js` 表达式，
 * 转成 JS 对象再写回会把标签丢掉。
 *
 * @throws 任一来源解析失败时抛 —— 这时不知道 `platformOrigin`，硬开账号插件可能删掉登录
 */
export function buildOverlay(sources: readonly PatchSource[]): string {
  const out = new Document()
  const seq = new YAMLSeq()
  out.contents = seq
  const entries = new Map<string, YAMLMap>()
  const entry = (id: string): YAMLMap => {
    let m = entries.get(id)
    if (m === undefined) {
      m = out.createNode({ id }) as YAMLMap
      entries.set(id, m)
    }
    return m
  }

  for (const { label, text } of sources) {
    const src = parseDocument(text)
    if (src.errors.length > 0) throw new Error(brief(label, src.errors[0]))
    const top = src.contents
    if (top !== null && !isSeq(top)) throw new Error(`${label} 顶层不是列表`)
    for (const item of top?.items ?? []) {
      if (!isMap(item)) continue
      const id = item.get('id')
      if (typeof id !== 'string' || !SYNC_IDS.has(id)) continue
      for (const key of ['disabled', 'config']) {
        const node: unknown = item.get(key, true)
        if (node !== undefined) entry(id).set(key, isNode(node) ? node.clone() : node)
      }
    }
  }

  // 用新节点整个换掉：原值若是 `!!js` 标量，set 一个裸值会保留标签、只改内容
  for (const id of FORCE_ENABLE) entry(id).set('disabled', out.createNode(false))
  if (!entry(ACCOUNT_ID).has('disabled')) entry(ACCOUNT_ID).set('disabled', out.createNode(false))

  for (const m of entries.values()) seq.add(m)
  out.commentBefore = ` 由 Krill 桥接在每次任务前生成，交给 dsh --patch；手改会被覆盖。\n`
    + ` 来源：${CHAT_PROFILE} profile 与 $DSH_HOME 两层 patch 的模型路由 + 恢复 headless 的存储认证。`
  return out.toString()
}

/** 按层序读出聊天那边的 patch 来源；文件不存在就跳过。`DSH_HOME` 与 dsh 自己的解析一致。 */
export function chatSources(): PatchSource[] {
  const home = dshHome()
  const files = [
    { label: `${CHAT_PROFILE} profile 的 cordis.patch.yml`, path: join(home, 'profiles', CHAT_PROFILE, 'cordis.patch.yml') },
    { label: '$DSH_HOME/cordis.patch.yml', path: join(home, 'cordis.patch.yml') },
  ]
  return files
    .filter((f) => existsSync(f.path))
    .map((f) => ({ label: f.label, text: readFileSync(f.path, 'utf8') }))
}

/**
 * 聊天那边生效的 `agent-default-model` 配置 —— 与 overlay 同一套合并，面板显示的就是实际跑的。
 * @returns 没有任何一层设过时为 null（两边都用 dsh-base 默认）
 * @throws 同 buildOverlay
 */
export function chatModelConfig(): Record<string, unknown> | null {
  const rows = parse(buildOverlay(chatSources())) as Array<{ id?: unknown; config?: unknown }>
  const cfg = rows.find((r) => r.id === 'agent-default-model')?.config
  return typeof cfg === 'object' && cfg !== null ? cfg as Record<string, unknown> : null
}

/**
 * 写 overlay 并返回路径。
 *
 * 固定一个文件、先写临时文件再 rename：并发的两个任务读到的总是某一版完整内容，
 * 最坏是先启动的那个读到了更新的一版 —— 那正是用户此刻的配置，无害。
 * 内容里可能有路由级 headers 或部署 cookie，权限给 0600。
 */
export function writeOverlay(): string {
  const text = buildOverlay(chatSources())
  const file = join(app.getPath('userData'), 'bridge-headless.patch.yml')
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
  return file
}
