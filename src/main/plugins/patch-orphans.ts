/**
 * profile `cordis.patch.yml` 里「孤儿 disabled 条目」的判定 —— 纯函数，不碰文件系统、
 * 不 import electron，好让 `tests/patch-orphans.check.ts` 用纯 node 跑。
 *
 * 一条 `disabled: true` 的行指向的 id 有两种合法来源：
 *   1. 一个**包**（注入器那类 loader 行的 id 就是包的短名）；
 *   2. 某个已装 **bundle 自己的 cordis.patch.yml 里 insert 的行**（dsh-vision-pack
 *      插的是 `vision` / `ui-vision`，和包名毫无关系）。
 *
 * 2026-09-05 只看第 1 种时把第 2 种全判成孤儿：用户故意停用 vision 的两行被「修复」
 * 清掉，vision 被启用，而它依赖的代码级补丁在升级后的运行时上没打上 —— 后端启动即崩。
 * 判孤儿宁可漏判，不可误判：漏判只是多留一行没用的 disabled，误判会把用户的停用抹掉。
 */
import { parse } from 'yaml'

export interface DisabledCandidate {
  id?: unknown
  disabled?: unknown
}

/** 从一份 bundle 的 patch 文本里收出它 insert 的所有 loader id（含顶层与嵌套）。坏 YAML 当作没声明。 */
export function bundleInsertIds(yamlText: string): string[] {
  let doc: unknown
  try {
    doc = parse(yamlText)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const ids: string[] = []
  const walk = (rows: readonly unknown[]): void => {
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const r = row as { id?: unknown; insert?: unknown }
      if (typeof r.id === 'string') ids.push(r.id)
      if (Array.isArray(r.insert)) walk(r.insert)
    }
  }
  walk(doc)
  return ids
}

/**
 * 哪些 disabled 行是孤儿：id 既不是一个存在的包，也没被任何已装 bundle 声明过。
 * @param entries - profile patch 的顶层条目
 * @param packageExists - 按 id 查包在不在（由调用方提供，带 scope 目录扫描）
 * @param declaredIds - 已装 bundle 们 insert 过的 id 全集
 * @returns 去重后的孤儿 id 列表，保持首次出现顺序
 */
export function orphanDisabledIds(
  entries: readonly DisabledCandidate[],
  packageExists: (id: string) => boolean,
  declaredIds: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.disabled !== true || typeof e.id !== 'string') continue
    if (declaredIds.has(e.id) || packageExists(e.id)) continue
    if (!out.includes(e.id)) out.push(e.id)
  }
  return out
}
