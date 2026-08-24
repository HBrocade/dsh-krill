/**
 * 读已装 pi-ai 的内置模型目录。
 *
 * 这份目录才是「可选模型列表」的真源：dsh 的 `catalog.ts` 直接从
 * `@earendil-works/pi-ai/providers/all` 取，而 discovery.ts 明说 ——
 * 目录里已有的供应商，点「拉取可用模型」**不发任何网络请求**，直接回目录内容。
 * 所以列表跟不上线上，跟 dsh 无关，是 pi-ai 那份**静态生成的快照**旧了。
 *
 * 好在快照是纯 JSON（`dist/providers/data/<id>.json`，按 api 分组），
 * 读它不需要把 pi-ai 真 import 进主进程 —— 那会把一整套 SDK 拖进 Electron。
 *
 * 这里**只读**。不改这份 JSON 的理由见 settings.ts 顶部。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CatalogApi } from '@shared/ipc'

/** pi-ai 目录 JSON 里一条模型记录中我们用得上的部分。 */
export interface InstalledModel {
  id: string
  name: string
  api: CatalogApi
  baseUrl: string
  compat: Record<string, unknown>
}

export interface InstalledCatalog {
  /** pi-ai 版本；读不出为 null */
  version: string | null
  /** 快照生成时间；读不出为 null */
  generatedAt: number | null
  dataDir: string
}

/**
 * 从 dsh 入口回溯出它实际用的那份 pi-ai。
 *
 * 逐级往上找而不是按固定层数切路径：入口在内嵌资源、userData 升级副本、
 * 用户自己 npm 装的三种布局下深度并不一样，数层数迟早数错。
 */
export function locateCatalog(dshBin: string | null): InstalledCatalog | null {
  if (dshBin === null || dshBin === '') return null
  let dir = dirname(dshBin)
  for (let i = 0; i < 12; i++) {
    const pkgDir = join(dir, 'node_modules', '@earendil-works', 'pi-ai')
    const dataDir = join(pkgDir, 'dist', 'providers', 'data')
    if (existsSync(dataDir)) {
      let version: string | null = null
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown }
        version = typeof pkg.version === 'string' ? pkg.version : null
      } catch { /* 版本只用于显示，读不到不影响功能 */ }
      let generatedAt: number | null = null
      try { generatedAt = statSync(join(pkgDir, 'dist', 'providers', 'all.js')).mtimeMs } catch { /* 同上 */ }
      return { version, generatedAt, dataDir }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const KNOWN_APIS: readonly CatalogApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']

function isKnownApi(v: string): v is CatalogApi {
  return (KNOWN_APIS as readonly string[]).includes(v)
}

/**
 * 一个供应商在已装目录里的全部模型。
 *
 * 不认识的 api 分组整组跳过：dsh 只把 pi-ai 的三种协议接了出来，
 * 别的协议就算读出来了也没法在声明式路线里表达。
 */
export function readProvider(cat: InstalledCatalog, provider: string): InstalledModel[] {
  const path = join(cat.dataDir, `${provider}.json`)
  if (!existsSync(path)) return []
  let groups: Record<string, Record<string, Record<string, unknown>>>
  try {
    groups = JSON.parse(readFileSync(path, 'utf8')) as typeof groups
  } catch {
    return []
  }
  const out: InstalledModel[] = []
  for (const [api, models] of Object.entries(groups)) {
    if (!isKnownApi(api)) continue
    for (const [id, m] of Object.entries(models)) {
      out.push({
        id,
        name: typeof m['name'] === 'string' ? m['name'] : id,
        api,
        baseUrl: typeof m['baseUrl'] === 'string' ? m['baseUrl'] : '',
        compat: (m['compat'] !== null && typeof m['compat'] === 'object'
          ? m['compat']
          : {}) as Record<string, unknown>,
      })
    }
  }
  return out
}

/** 这个供应商在已装目录里存在吗 —— 不存在说明它是用户自己声明的路线，没有目录可比。 */
export function hasProvider(cat: InstalledCatalog, provider: string): boolean {
  return existsSync(join(cat.dataDir, `${provider}.json`))
}
