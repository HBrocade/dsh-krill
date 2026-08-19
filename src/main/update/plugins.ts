/**
 * 已装插件的版本检测。
 *
 * 读 `~/.dsh/profiles/<p>/package.json` 的 dependencies，逐个查 registry。
 * 只查**从 registry 装的**依赖 —— `file:` / `link:` / `github:` 这些本地或 git 来源
 * 在 registry 上查不到，查了只会得到一堆 404 噪声，直接跳过。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fetchManyLatest } from './registry.ts'
import { isUpgrade } from '@shared/semver'
import type { PluginUpdate, PluginSource } from '@shared/ipc'
import { locateDsh } from '../backend/locate.ts'
import { dirname, resolve as resolvePath } from 'node:path'

export function profilesRoot(): string {
  return join(homedir(), '.dsh', 'profiles')
}

/** 列出所有 profile 名（目录里有 package.json 才算）。 */
export function listProfiles(): string[] {
  const root = profilesRoot()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'package.json')))
      .map((d) => d.name)
  } catch {
    return []
  }
}

export interface ProfileManifest {
  profile: string
  dependencies: Record<string, string>
  /** dsh.profile.bundles —— 参与层叠的包，顺序有意义 */
  bundles: string[]
}

export function readManifest(profile: string): ProfileManifest | null {
  const file = join(profilesRoot(), profile, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: unknown } }
    }
    const rawBundles = pkg.dsh?.profile?.bundles
    return {
      profile,
      dependencies: pkg.dependencies ?? {},
      bundles: Array.isArray(rawBundles) ? rawBundles.filter((b): b is string => typeof b === 'string') : [],
    }
  } catch {
    return null
  }
}

/** 装在 profile 的 node_modules 里的实际版本（manifest 里的是范围，不是实际版本）。 */
export function installedVersion(profile: string, name: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(profilesRoot(), profile, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** registry 查不到的来源前缀，逐个跳过而不是查完再丢。 */
const NON_REGISTRY = ['file:', 'link:', 'github:', 'git+', 'git:', 'http:', 'https:', 'workspace:', 'portal:']

function fromRegistry(spec: string): boolean {
  return !NON_REGISTRY.some((p) => spec.startsWith(p))
}

/**
 * dsh 运行时自带包的版本。
 *
 * `dsh.profile.bundles` 里有些包（dsh-base、dsh-web-app）并不在 profile 的
 * dependencies 里 —— 它们是 dsh 自己的依赖，从运行时的 node_modules 解析。
 * 这类包的版本跟着 dsh CLI 走，独立升级没有意义，但必须列出来，
 * 否则面板会漏掉实际参与层叠的成员。
 */
export function runtimeVersion(name: string): string | null {
  const located = locateDsh()
  if (located === null) return null
  // located.bin 形如 <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
  // dirname 是 .../lib，往上 3 层正好是 node_modules（lib → dsh → @deepseek-ai → node_modules）
  const nodeModules = resolvePath(dirname(located.bin), '..', '..', '..')
  try {
    const pkg = JSON.parse(
      readFileSync(join(nodeModules, ...name.split('/'), 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

export async function check(options: { force?: boolean } = {}): Promise<PluginUpdate[]> {
  const targets: Array<{ profile: string; name: string; current: string | null; inBundles: boolean }> = []
  const others: PluginUpdate[] = []

  for (const profile of listProfiles()) {
    const manifest = readManifest(profile)
    if (manifest === null) continue
    const bundleSet = new Set(manifest.bundles)

    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      const current = installedVersion(profile, name)
      const inBundles = bundleSet.has(name)
      if (!fromRegistry(spec)) {
        // 本地/git 来源：如实列出但标明无法检查，比悄悄漏掉一个插件好
        others.push({
          name, profile, source: 'local' as PluginSource, current,
          latest: null, upgradable: false, inBundles,
          error: `来源 ${spec.split(':')[0]}:，不在 registry 上，无法比对版本`,
        })
        continue
      }
      targets.push({ profile, name, current, inBundles })
    }

    // bundles 里但不在 dependencies 里的 —— 随 dsh 运行时自带
    for (const name of manifest.bundles) {
      if (Object.hasOwn(manifest.dependencies, name)) continue
      others.push({
        name, profile, source: 'runtime' as PluginSource,
        current: runtimeVersion(name) ?? installedVersion(profile, name),
        latest: null, upgradable: false, inBundles: true, error: null,
      })
    }
  }

  if (targets.length === 0) return sortRows(others)

  const names = [...new Set(targets.map((t) => t.name))]
  const results = await fetchManyLatest(names, options)

  const checked = targets.map<PluginUpdate>((t) => {
    const r = results.get(t.name)
    const latest = r?.latest ?? null
    return {
      name: t.name,
      profile: t.profile,
      source: 'registry',
      current: t.current,
      latest,
      upgradable: t.current !== null && latest !== null && isUpgrade(t.current, latest),
      inBundles: t.inBundles,
      error: r?.error ?? null,
    }
  })

  return sortRows([...checked, ...others])
}

/** 可升级的排最前，其次是能查的，随运行时的排最后 —— 要处理的一眼可见。 */
function sortRows(rows: PluginUpdate[]): PluginUpdate[] {
  const rank = (r: PluginUpdate): number => {
    if (r.upgradable) return 0
    if (r.source === 'registry') return 1
    if (r.source === 'local') return 2
    return 3
  }
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
}
