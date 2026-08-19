/**
 * 语义化版本比较 —— 只做这个项目需要的那部分，不引第三方库。
 *
 * 为什么不能用 registry 的 `dist-tags.latest`（这是本项目的头号坑）：
 * dsh 家族在 npm 上的 `latest` 标签指向 `0.0.1-rc.1`，而实际最新是 `0.1.0-rc.7`。
 * 直接读 latest 会把「有新版」判成「要降级」。所以一律拉 `versions` 全集，
 * 用这里的比较函数排序取最大。
 */

/** 一个解析后的版本。`pre` 为空数组表示正式版。 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识符序列，如 `0.1.0-rc.7` → ['rc', 7] */
  pre: Array<string | number>
  raw: string
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 解析一个版本号；不符合 semver 的返回 null（调用方负责跳过，不要抛）。
 * registry 里偶有非法版本，遇到就忽略比让整个检查崩掉好。
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = SEMVER.exec(raw.trim())
  if (!m) return null
  const [, ma, mi, pa, pre] = m
  return {
    major: Number(ma),
    minor: Number(mi),
    patch: Number(pa),
    pre: pre === undefined || pre === '' ? [] : pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
    raw: raw.trim(),
  }
}

/** 比较预发布序列，遵循 semver 规范：数字段 < 字符串段，短的前缀更小。 */
function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  // 有预发布 < 无预发布（1.0.0-rc.1 < 1.0.0）
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) return (x as number) < (y as number) ? -1 : 1
    if (xNum) return -1
    if (yNum) return 1
    return (x as string) < (y as string) ? -1 : 1
  }
  return 0
}

/** a < b 返回负数，a > b 返回正数，相等返回 0。无法解析的一律视为最小。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null && pb === null) return 0
  if (pa === null) return -1
  if (pb === null) return 1
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return comparePre(pa.pre, pb.pre)
}

/**
 * 从版本列表里挑最大的一个。
 * @param versions - registry 的 `versions` 键全集。
 * @param options.allowPrerelease - 是否接受预发布版。dsh 家族当前**全是** rc，
 *   所以默认 true —— 设成 false 会一个候选都挑不出来。
 * @returns 最大版本；列表为空或全部非法时返回 null。
 */
export function maxVersion(
  versions: readonly string[],
  options: { allowPrerelease?: boolean } = {},
): string | null {
  const allowPre = options.allowPrerelease ?? true
  let best: string | null = null
  for (const v of versions) {
    const parsed = parseVersion(v)
    if (parsed === null) continue
    if (!allowPre && parsed.pre.length > 0) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  return best
}

/** 语义化的「有没有新版」判断，避免调用点到处写 compareVersions(...) > 0。 */
export function isUpgrade(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}
