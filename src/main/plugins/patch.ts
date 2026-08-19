/**
 * profile 的 `cordis.patch.yml` 读取、体检与修复。
 *
 * 两条会真正咬人的规则：
 *
 *  1. **同 id 只许一条**。dsh loader 装配遇到重复 id 直接抛
 *     `duplicate loader entry id`，**启动即崩**。注入器的注释里记着它自己踩过：
 *     多次卸载累积出 6 个同名 disabled 条目。
 *  2. **文件必须是单一顶层值**。官方初始内容是顶层 `[]`（空数组），
 *     盲目 append `- id:` 会造出两个顶层 YAML 值 → 解析必炸。
 *
 * 所以这里一律「解析 → 改结构 → 整份写回」，绝不做文本追加。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { profilesRoot } from '../update/plugins.ts'
import { log } from '../backend/log-ring.ts'
import type { PatchHealth } from '@shared/ipc'

/** patch 文件里的一条 loader 条目。字段远不止这些，未知字段原样保留。 */
export interface PatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  config?: unknown
  insert?: PatchEntry[]
  [k: string]: unknown
}

export function patchPath(profile: string): string {
  return join(profilesRoot(), profile, 'cordis.patch.yml')
}

/**
 * 读并解析。
 * @returns 条目数组；文件不存在返回空数组；解析失败抛（调用方转成 parseError）
 */
export function read(profile: string): PatchEntry[] {
  const file = patchPath(profile)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8')
  const doc: unknown = parse(raw)
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) {
    throw new Error('顶层不是数组 —— patch 文件必须是单一顶层 YAML 列表（或空数组 []）')
  }
  return doc as PatchEntry[]
}

/** 递归收集所有 id（含 insert 里的嵌套条目）。 */
function collectIds(entries: readonly PatchEntry[], out: string[] = []): string[] {
  for (const e of entries) {
    if (typeof e.id === 'string') out.push(e.id)
    if (Array.isArray(e.insert)) collectIds(e.insert, out)
  }
  return out
}

/**
 * 某个包在 profile 的 node_modules 里还在不在 —— 用来判断 disabled 条目是不是孤儿。
 *
 * patch 里的 id 是**短名**（如 `dsh-super-injector`），而磁盘上是带 scope 的
 * （`@dsh-external/dsh-super-injector`），所以顶层找不到时要逐个 scope 目录再找一遍。
 * scope 列表实际扫描得出，不硬编码 —— 生态里的 scope 不止官方那两个。
 */
function packageExists(profile: string, id: string): boolean {
  const nm = join(profilesRoot(), profile, 'node_modules')
  if (!existsSync(nm)) return false
  if (existsSync(join(nm, id))) return true
  try {
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
      if (existsSync(join(nm, entry.name, id))) return true
    }
  } catch {
    // 读不了 node_modules 时宁可当作「包还在」，避免误判成孤儿而被清掉
    return true
  }
  return false
}

export function inspect(profile: string): PatchHealth {
  const base: PatchHealth = {
    profile, path: patchPath(profile),
    duplicateIds: [], orphanDisabled: [], parseError: null,
  }
  let entries: PatchEntry[]
  try {
    entries = read(profile)
  } catch (e) {
    return { ...base, parseError: e instanceof Error ? e.message : String(e) }
  }

  const ids = collectIds(entries)
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dup.add(id)
    seen.add(id)
  }

  const orphans = entries
    .filter((e) => e.disabled === true && typeof e.id === 'string')
    .map((e) => e.id as string)
    .filter((id) => !packageExists(profile, id))

  return { ...base, duplicateIds: [...dup], orphanDisabled: [...new Set(orphans)] }
}

/**
 * 修复：按 id 去重（保留第一条），清掉指向已不存在的包的 disabled 条目。
 *
 * 写入前一律备份 —— 这个文件写坏了 dsh 就起不来，备份是最后一道保险。
 * @returns 修复后的体检结果
 */
export function heal(profile: string): PatchHealth {
  const file = patchPath(profile)
  const before = inspect(profile)
  if (before.parseError !== null) {
    throw new Error(`patch 解析失败，不敢自动改写：${before.parseError}`)
  }
  // 官方允许 patch 里写 `!!js` 自定义标签。我们的修复是「解析 → 改结构 → 整份写回」，
  // 这类标签往返一趟很可能被丢掉或改形 —— 那等于替用户毁了配置。宁可不修，只报告。
  if (existsSync(file) && /!!js/.test(readFileSync(file, 'utf8'))) {
    throw new Error(
      '这份 patch 里含 `!!js` 自定义标签。自动修复要整份重写文件，'
      + '可能破坏这些表达式，因此拒绝改写。请手动处理，或先移除 !!js 段落再修复。',
    )
  }
  if (before.duplicateIds.length === 0 && before.orphanDisabled.length === 0) return before

  const entries = read(profile)
  const seen = new Set<string>()
  const orphan = new Set(before.orphanDisabled)
  const kept = entries.filter((e) => {
    const id = typeof e.id === 'string' ? e.id : null
    if (id !== null && e.disabled === true && orphan.has(id)) return false
    if (id === null) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  const backup = `${file}.bak-${String(Date.now())}`
  if (existsSync(file)) copyFileSync(file, backup)
  // 空列表要写成 `[]`（官方初始形式），不能写成空文件
  writeFileSync(file, kept.length === 0 ? '[]\n' : stringify(kept), 'utf8')
  log(`patch 体检修复 ${profile}：去重 ${before.duplicateIds.length} 个 id，`
    + `清理 ${before.orphanDisabled.length} 个孤儿 disabled，备份于 ${backup}`)
  return inspect(profile)
}
