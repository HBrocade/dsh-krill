/**
 * npm registry 查询。
 *
 * **绝不读 `dist-tags.latest`** —— dsh 家族在 npm 上的 latest 标签是错的：
 * `@deepseek-ai/dsh-base` 的 latest 指向 `0.0.1-rc.1`，而实际最新是 `0.1.0-rc.7`。
 * 照 latest 判断会把升级报成降级。一律拉 `versions` 全集自己排序。
 *
 * 用 abbreviated 文档（`application/vnd.npm.install-v1+json`）：只含安装所需字段，
 * 比完整文档小一个数量级，我们只要版本号列表，够用。
 */
import { maxVersion } from '@shared/semver'

const REGISTRY = 'https://registry.npmjs.org'
const TIMEOUT_MS = 15_000
/** 缓存 TTL：定时检查缺省 6 小时一次，10 分钟足够挡住面板上的连点 */
const CACHE_TTL_MS = 10 * 60 * 1000

export interface PackageVersions {
  /** 全部已发布版本，未排序 */
  versions: string[]
  /** semver 排序后的最大版本；无可用版本为 null */
  latest: string | null
  /** registry 自称的 latest 标签 —— 仅供诊断，不要拿来做判断 */
  taggedLatest: string | null
}

interface CacheEntry { at: number; value: PackageVersions }
const cache = new Map<string, CacheEntry>()

/**
 * 查一个包的全部版本。
 * @param name - 包名，如 `@deepseek-ai/dsh`
 * @param options.force - 忽略缓存
 * @throws 网络失败、超时、404 时抛，调用方负责收成 `error` 字段
 */
export async function fetchVersions(
  name: string,
  options: { force?: boolean } = {},
): Promise<PackageVersions> {
  const hit = cache.get(name)
  if (hit !== undefined && options.force !== true && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(res.status === 404 ? `registry 里没有包 ${name}` : `registry 返回 ${res.status}`)
    }
    const body = await res.json() as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    const versions = Object.keys(body.versions ?? {})
    const value: PackageVersions = {
      versions,
      latest: maxVersion(versions),
      taggedLatest: body['dist-tags']?.['latest'] ?? null,
    }
    cache.set(name, { at: Date.now(), value })
    return value
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`查询 ${name} 超时（${TIMEOUT_MS / 1000}s）`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量查，失败的条目单独带错误返回，不让一个包的失败拖垮整轮检查。
 * 并发上限 6，避免一次几十个包把 registry 打出限流。
 */
export async function fetchManyLatest(
  names: readonly string[],
  options: { force?: boolean } = {},
): Promise<Map<string, { latest: string | null; error: string | null }>> {
  const out = new Map<string, { latest: string | null; error: string | null }>()
  const queue = [...names]
  const worker = async (): Promise<void> => {
    for (;;) {
      const name = queue.shift()
      if (name === undefined) return
      try {
        const r = await fetchVersions(name, options)
        out.set(name, { latest: r.latest, error: null })
      } catch (e) {
        out.set(name, { latest: null, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, names.length) }, worker))
  return out
}

/** 清空缓存（手动「立即检查」时用）。 */
export function clearCache(): void { cache.clear() }
