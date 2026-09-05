/**
 * 插件检索存档（`userData/plugin-search.json`）。
 *
 * 存的是**模型说过的话**，不是既成事实 —— 所以这份文件只进桌面端自己的
 * userData，绝不写进 `~/.dsh`：那边是 dsh 真正在读的配置，混进一份「某个模型
 * 觉得存在的包名」列表，迟早有人当成真的。
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DiscoverHit, DiscoverRecord } from '@shared/ipc'

/** 存到 200 条封顶。检索是查完就用的东西，攒着的价值随时间衰减得很快。 */
const CAP = 200

export function storePath(): string {
  return join(app.getPath('userData'), 'plugin-search.json')
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function asConfidence(v: unknown): DiscoverHit['confidence'] {
  return v === 'high' || v === 'low' ? v : 'medium'
}

/** 逐字段过一遍再收下。这份文件用户能手改，也可能是旧版本写的。 */
function toHit(raw: unknown): DiscoverHit | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = asString(r['name'])
  if (name === null) return null
  return {
    name,
    summary: asString(r['summary']) ?? '',
    install: asString(r['install']),
    homepage: asString(r['homepage']),
    confidence: asConfidence(r['confidence']),
    note: asString(r['note']),
  }
}

function toRecord(raw: unknown): DiscoverRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = asString(r['id'])
  if (id === null) return null
  return {
    id,
    ts: typeof r['ts'] === 'number' ? r['ts'] : 0,
    query: asString(r['query']) ?? '',
    routeId: asString(r['routeId']) ?? '',
    model: asString(r['model']) ?? '',
    hits: (Array.isArray(r['hits']) ? r['hits'] : [])
      .map(toHit)
      .filter((h): h is DiscoverHit => h !== null),
    raw: typeof r['raw'] === 'string' ? r['raw'] : '',
    error: asString(r['error']),
  }
}

/** 读存档。读不动就当空档 —— 检索历史坏了不该让插件面板打不开。 */
export function load(): DiscoverRecord[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(storePath(), 'utf8'))
  } catch {
    return []
  }
  const list = Array.isArray(raw) ? raw : (raw as { records?: unknown })?.records
  return (Array.isArray(list) ? list : [])
    .map(toRecord)
    .filter((r): r is DiscoverRecord => r !== null)
    .sort((a, b) => b.ts - a.ts)
}

/** 原子写：先写临时文件再 rename，避免写一半被杀留下半截 JSON。 */
export function save(records: readonly DiscoverRecord[]): DiscoverRecord[] {
  const kept = [...records].sort((a, b) => b.ts - a.ts).slice(0, CAP)
  const target = storePath()
  const tmp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8')
  renameSync(tmp, target)
  return kept
}
