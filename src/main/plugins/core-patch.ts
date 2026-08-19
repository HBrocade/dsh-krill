/**
 * 代码级补丁（创意工坊式插件的核心能力）。
 *
 * 有些插件光靠挂载做不到 —— 它需要宿主自己的代码配合。识图就是例子：
 * `vision_inspect` 要能寻址图片，前提是 `dsh-llm` 里有 `placeholderImages()`
 * 把图片换成 `[图片 #n]` 占位符，且 apiproxy 放行图片附件。这些都在已发布的
 * 核心包里，插件层给不了。
 *
 * 所以插件包可以随包携带 pnpm patch，由这里负责应用与撤销。
 *
 * 三条铁律（都是「改别人代码」这件事必然要面对的）：
 *
 *  1. **版本钉死。** 每个补丁声明它针对哪个上游版本。装的版本对不上就拒绝，
 *     不做模糊匹配 —— 补丁打歪比不打更糟，它会产出一个能跑但行为错乱的宿主。
 *  2. **可逆。** 卸载插件要能把补丁一并撤掉，不留痕。
 *  3. **失败必须响。** 实测 pnpm 在版本对不上时是硬失败的
 *     （`ERR_PNPM_UNUSED_PATCH`，退出码 1），这点它做得对。
 *     但报错是 pnpm 的词汇，用户看不懂自己该干什么 —— 所以这里在跑安装
 *     **之前**就先比对版本并给出人话解释，而不是让用户对着
 *     `ERR_PNPM_UNUSED_PATCH` 猜。装完仍然回读校验，因为「补丁应用了」
 *     和「补丁产生了预期效果」是两件事。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { profilesRoot, installedVersion } from '../update/plugins.ts'
import { log } from '../backend/log-ring.ts'

/** 插件包在自己的 package.json 里用 `krill.corePatches` 声明。 */
export interface CorePatchDecl {
  /** 目标包名，如 @deepseek-ai/dsh-llm */
  package: string
  /** 针对的上游版本 —— 必须精确匹配，不做范围 */
  version: string
  /** 相对插件目录的 .patch 路径 */
  file: string
  /** 一句话说明这个补丁干什么，面板上要给用户看 */
  reason?: string
}

export interface CorePatchStatus extends CorePatchDecl {
  /** profile 里实际装的版本 */
  installedVersion: string | null
  /** 版本是否匹配 */
  versionMatches: boolean
  /** 是否已写进 pnpm-workspace.yaml 的 patchedDependencies */
  declared: boolean
  /** 补丁文件是否已复制到 profile */
  filePresent: boolean
}

export function readDecls(pluginDir: string): CorePatchDecl[] {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
      krill?: { corePatches?: unknown }
    }
    const raw = pkg.krill?.corePatches
    if (!Array.isArray(raw)) return []
    return raw.filter((d): d is CorePatchDecl =>
      d !== null && typeof d === 'object'
      && typeof (d as CorePatchDecl).package === 'string'
      && typeof (d as CorePatchDecl).version === 'string'
      && typeof (d as CorePatchDecl).file === 'string')
  } catch {
    return []
  }
}

function workspacePath(profile: string): string {
  return join(profilesRoot(), profile, 'pnpm-workspace.yaml')
}

/** profile 里存放补丁文件的目录 —— 与 pnpm 惯例一致。 */
function patchDir(profile: string): string {
  return join(profilesRoot(), profile, 'patches')
}

function readWorkspace(profile: string): Record<string, unknown> {
  const f = workspacePath(profile)
  if (!existsSync(f)) return {}
  try {
    const doc = parse(readFileSync(f, 'utf8')) as Record<string, unknown> | null
    return doc ?? {}
  } catch {
    return {}
  }
}

function writeWorkspace(profile: string, doc: Record<string, unknown>): void {
  const f = workspacePath(profile)
  if (existsSync(f)) copyFileSync(f, `${f}.bak-${String(Date.now())}`)
  mkdirSync(join(profilesRoot(), profile), { recursive: true })
  writeFileSync(f, stringify(doc), 'utf8')
}

/** pnpm 的 patchedDependencies 键是 `包名@版本`。 */
function patchKey(d: CorePatchDecl): string {
  return `${d.package}@${d.version}`
}

export function inspect(profile: string, pluginDir: string): CorePatchStatus[] {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []
  const ws = readWorkspace(profile)
  const patched = (ws['patchedDependencies'] ?? {}) as Record<string, unknown>
  return decls.map((d) => {
    const got = installedVersion(profile, d.package)
    return {
      ...d,
      installedVersion: got,
      versionMatches: got === d.version,
      declared: Object.hasOwn(patched, patchKey(d)),
      filePresent: existsSync(join(patchDir(profile), `${d.package.replace(/\//g, '__')}.patch`)),
    }
  })
}

/**
 * 把补丁写进 profile。
 *
 * **只写声明，不执行安装** —— 安装由调用方接着跑 `dsh plugin ... install`，
 * 这样输出能流式回传给面板，用户看得见 pnpm 到底说了什么。
 *
 * @throws 版本对不上时抛，绝不"凑合打上去"
 */
export function apply(profile: string, pluginDir: string): string[] {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []

  const mismatched = inspect(profile, pluginDir).filter((s) => !s.versionMatches)
  if (mismatched.length > 0) {
    throw new Error(
      '代码级补丁的目标版本对不上，拒绝应用：\n'
      + mismatched.map((s) =>
        `  ${s.package}：补丁针对 ${s.version}，实际装的是 ${s.installedVersion ?? '未安装'}`).join('\n')
      + '\n补丁打歪会产出一个能跑但行为错乱的宿主，比不打更糟。'
      + '请等插件作者出适配新版本的补丁，或把该包降回目标版本。',
    )
  }

  const dir = patchDir(profile)
  mkdirSync(dir, { recursive: true })
  const applied: string[] = []
  const ws = readWorkspace(profile)
  const patched = { ...(ws['patchedDependencies'] ?? {}) } as Record<string, string>

  for (const d of decls) {
    const src = join(pluginDir, d.file)
    if (!existsSync(src)) throw new Error(`插件声明了补丁但文件不存在：${src}`)
    const name = `${d.package.replace(/\//g, '__')}.patch`
    copyFileSync(src, join(dir, name))
    patched[patchKey(d)] = `patches/${name}`
    applied.push(`${d.package}@${d.version}`)
  }

  ws['patchedDependencies'] = patched
  writeWorkspace(profile, ws)
  log(`已写入 ${applied.length} 处代码级补丁声明：${applied.join('、')}`)
  return applied
}

/** 撤销：从声明里删掉并移除补丁文件。卸载插件时调用。 */
export function revert(profile: string, pluginDir: string): string[] {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []
  const ws = readWorkspace(profile)
  const patched = { ...(ws['patchedDependencies'] ?? {}) } as Record<string, string>
  const removed: string[] = []

  for (const d of decls) {
    if (Object.hasOwn(patched, patchKey(d))) {
      delete patched[patchKey(d)]
      removed.push(patchKey(d))
    }
    rmSync(join(patchDir(profile), `${d.package.replace(/\//g, '__')}.patch`), { force: true })
  }

  if (Object.keys(patched).length === 0) delete ws['patchedDependencies']
  else ws['patchedDependencies'] = patched
  writeWorkspace(profile, ws)
  if (removed.length > 0) log(`已撤销 ${removed.length} 处代码级补丁：${removed.join('、')}`)
  return removed
}

/**
 * 装完回读校验：补丁到底生效了没有。
 *
 * pnpm 会保证补丁被应用（版本对不上时硬失败），但保证不了补丁**打出了预期效果** ——
 * 比如补丁上下文匹配到了错误的位置、或者目标符号被上游改了名而补丁仍能应用。
 * 所以每处补丁都给一个可在产物里搜到的标记串，装完逐个回读。
 *
 * @param probes - 每处补丁一个探针：在目标包的哪个文件里应该能搜到什么串
 */
export function verify(
  profile: string,
  probes: ReadonlyArray<{ package: string; file: string; contains: string }>,
): Array<{ package: string; ok: boolean; detail: string }> {
  return probes.map((p) => {
    const f = join(profilesRoot(), profile, 'node_modules', ...p.package.split('/'), p.file)
    if (!existsSync(f)) {
      return { package: p.package, ok: false, detail: `产物不存在：${f}` }
    }
    try {
      const ok = readFileSync(f, 'utf8').includes(p.contains)
      return {
        package: p.package,
        ok,
        detail: ok
          ? `已生效（在 ${p.file} 里找到 ${p.contains}）`
          : `**补丁未生效** —— ${p.file} 里找不到 ${p.contains}。`
            + 'pnpm 打补丁失败时只警告不报错，安装仍会成功，所以必须回读校验。',
      }
    } catch (e) {
      return { package: p.package, ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  })
}
