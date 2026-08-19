/**
 * 插件清单：把三个来源合并成一份面板能用的列表。
 *
 *   1. profile 的 `package.json` —— dependencies（官方装配态）+ dsh.profile.bundles（层叠成员）
 *   2. 注入器 `/list` —— 运行时注入态与 fiber 活跃状态
 *   3. 各包自己的 `package.json` —— 版本、描述、有没有 dsh.bundle / dsh.client
 *
 * 三者按包名归并。**任一来源缺席都不该让整个清单空掉** ——
 * 注入器是第三方插件，后端也可能没起来，这两种情况都要能降级出结果。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listProfiles, readManifest, profilesRoot, runtimeVersion } from '../update/plugins.ts'
import * as injector from './injector.ts'
import * as patch from './patch.ts'
import { log } from '../backend/log-ring.ts'
import type { PluginEntry, PluginsState, PluginChannel } from '@shared/ipc'

/** 桌面端自管的插件解压目录 —— 下载来的包放这，不污染 profile。 */
export function desktopPluginsRoot(): string {
  return join(profilesRoot(), '..', 'desktop-plugins')
}

interface PackageMeta {
  version: string | null
  description: string | null
  isBundle: boolean
  hasClient: boolean
  clientBundleMissing: boolean
  dir: string | null
}

/** 在 profile 的 node_modules 里定位一个包（顶层或任意 @scope 下）。 */
function resolvePackageDir(profile: string, name: string): string | null {
  const nm = join(profilesRoot(), profile, 'node_modules')
  const direct = join(nm, ...name.split('/'))
  if (existsSync(join(direct, 'package.json'))) return direct
  if (name.includes('/')) return null
  // patch 里的 id 是短名，磁盘上带 scope —— 逐个 scope 找
  try {
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('@')) continue
      const p = join(nm, e.name, name)
      if (existsSync(join(p, 'package.json'))) return p
    }
  } catch { /* node_modules 读不到 */ }
  return null
}

function readMeta(profile: string, name: string): PackageMeta {
  const dir = resolvePackageDir(profile, name)
  const empty: PackageMeta = {
    version: null, description: null, isBundle: false,
    hasClient: false, clientBundleMissing: false, dir,
  }
  if (dir === null) {
    // bundles 里但不在 profile node_modules 的包（dsh-base、dsh-web-app）
    // 随 dsh 运行时走，版本要从运行时的 node_modules 读，否则面板显示成「—」，
    // 和更新面板对不上
    return { ...empty, version: runtimeVersion(name) }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      version?: unknown
      description?: unknown
      dsh?: { bundle?: { patch?: unknown }; client?: unknown }
    }
    const hasClient = pkg.dsh?.client !== undefined && pkg.dsh.client !== null
    return {
      version: typeof pkg.version === 'string' ? pkg.version : null,
      description: typeof pkg.description === 'string' ? pkg.description : null,
      isBundle: pkg.dsh?.bundle?.patch !== undefined,
      hasClient,
      // 声明了 client 却没构建出 lib/client.js —— 装上不会有 UI，必须显式提示，
      // 不能让它静默无效果（这是「装了但没反应」最常见的一种）
      clientBundleMissing: hasClient && !existsSync(join(dir, 'lib', 'client.js')),
      dir,
    }
  } catch {
    return empty
  }
}

/** 从注入器条目里取包名 —— 它可能给 name 也可能只给 id。 */
function entryName(e: injector.InjectorEntry): string | null {
  if (typeof e.name === 'string' && e.name !== '') return e.name
  if (typeof e.id === 'string' && e.id !== '') return e.id
  return null
}

export async function collect(): Promise<PluginsState> {
  let injectorAvailable = false
  let injected = new Map<string, injector.InjectorEntry>()
  try {
    const r = await injector.list()
    injectorAvailable = r.ok
    for (const e of r.entries) {
      const n = entryName(e)
      if (n !== null) injected.set(n, e)
    }
  } catch (e) {
    // 注入器缺席是正常情况，不当错误报 —— 面板据此标注「热更新不可用」
    injectorAvailable = false
    injected = new Map()
    log(`注入器不可用，插件面板降级为只读 + 官方通道：${e instanceof Error ? e.message : String(e)}`)
  }

  const entries: PluginEntry[] = []
  let restartRequired = false
  const profiles = listProfiles()
  // 体检只针对当前实际在跑的 web profile；其它 profile 的 patch 不在本次范围
  const health = patch.inspect(profiles.includes('web') ? 'web' : (profiles[0] ?? 'web'))

  for (const profile of profiles) {
    const manifest = readManifest(profile)
    if (manifest === null) continue

    let patchEntries: patch.PatchEntry[] = []
    try { patchEntries = patch.read(profile) } catch { patchEntries = [] }
    const disabledIds = new Set(
      patchEntries.filter((e) => e.disabled === true && typeof e.id === 'string').map((e) => e.id as string),
    )

    const names = new Set<string>([
      ...Object.keys(manifest.dependencies),
      ...manifest.bundles,
      ...injected.keys(),
    ])

    for (const name of names) {
      const inDeps = Object.hasOwn(manifest.dependencies, name)
      const inBundles = manifest.bundles.includes(name)
      const hot = injected.has(name)
      const meta = readMeta(profile, name)

      // 注入器上报的包如果不属于这个 profile，跳过，避免每个 profile 都重复列一遍
      if (!inDeps && !inBundles && hot && meta.dir === null) continue

      const channel: PluginChannel =
        inDeps && hot ? 'both' : hot ? 'injected' : inDeps || inBundles ? 'official' : 'none'

      const shortId = name.split('/').pop() ?? name
      const disabled = disabledIds.has(shortId) || disabledIds.has(name)
      if (disabled) restartRequired = true

      entries.push({
        name,
        version: meta.version,
        description: meta.description,
        profile,
        channel,
        isBundle: meta.isBundle || inBundles,
        hasClient: meta.hasClient,
        clientBundleMissing: meta.clientBundleMissing,
        active: hot ? (injected.get(name)?.active ?? null) : null,
        pendingRemoval: false,
        disabled,
        dir: meta.dir,
      })
    }
  }

  // 有问题的排前面：两通道并存（会造重复 id）、client 未构建、被禁用
  const rank = (e: PluginEntry): number => {
    if (e.channel === 'both') return 0
    if (e.clientBundleMissing) return 1
    if (e.disabled) return 2
    if (e.channel === 'injected') return 3
    return 4
  }
  entries.sort((a, b) => {
    const d = rank(a) - rank(b)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })

  return { injectorAvailable, restartRequired, entries, patchHealth: health }
}
