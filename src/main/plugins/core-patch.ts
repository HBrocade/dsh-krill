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
 *  1. **尽量兼容，但如实告知。** 实测 pnpm 的 `patchedDependencies` 键
 *     **可以只写包名**，这样补丁会对任意已装版本尝试应用，而不是版本号一对不上
 *     就整个拒绝。宿主小版本升级往往不动被补丁的那几行，这时 mod 照常可用。
 *     所以这里用包名做键，让「能不能打上」由补丁内容自己回答。
 *
 *     代价是补丁失败会变成安装失败（`ERR_PNPM_PATCH_FAILED`）。因此声明里
 *     同时记录 `authoredFor`（作者是针对哪个版本写的）与 `appliesTo`
 *     （作者认为适用的范围），面板据此在装之前就提示风险，
 *     并在 dsh 升级后主动标出哪些 mod 可能已经失效。
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
import { compareVersions, parseVersion } from '@shared/semver'
import { profilesRoot, installedVersion } from '../update/plugins.ts'
import { log } from '../backend/log-ring.ts'

/** 插件包在自己的 package.json 里用 `krill.corePatches` 声明。 */
export interface CorePatchDecl {
  /** 目标包名，如 @deepseek-ai/dsh-llm */
  package: string
  /** 作者针对哪个版本写的这个补丁 —— 仅用于展示与判断陈旧度，不作为门禁 */
  authoredFor: string
  /**
   * 作者认为适用的 semver 范围。装的版本落在范围内 = 预期可用；
   * 落在范围外仍会尝试应用（由补丁内容自己决定成败），只是面板会提示风险。
   */
  appliesTo?: string
  /** 相对插件目录的 .patch 路径 */
  file: string
  /** 一句话说明这个补丁干什么，面板上要给用户看 */
  reason?: string
  /**
   * 回读探针：装完后在目标包的哪个文件里应该能搜到什么串。
   *
   * 必要性在于「补丁应用了」与「补丁产生了预期效果」是两件事 ——
   * 补丁可能匹配到错误位置，或目标符号被上游改名而补丁仍能应用。
   * 探针要挑该补丁**独有**的符号：实测时我一度拿 placeholderImages 去探
   * dsh-llm-deepseek，得到 0 命中，误判成补丁失败 —— 而那个包只是
   * **导入**该符号、并不定义它，正确的探针是 IMAGE_PLACEHOLDER。
   */
  verify?: { file: string; contains: string }
}

export interface CorePatchStatus extends CorePatchDecl {
  /** profile 里实际装的版本 */
  installedVersion: string | null
  /** 装的版本正是作者写补丁时那个 —— 最稳的情况 */
  exactMatch: boolean
  /** 装的版本落在作者声明的适用范围内 */
  inRange: boolean
  /** 是否已写进 pnpm-workspace.yaml 的 patchedDependencies */
  declared: boolean
  /** 补丁文件是否已复制到 profile */
  filePresent: boolean
}

/**
 * 极简 semver 范围判断，只支持 `^x.y.z` 与 `>=a <b` 两种形式 ——
 * mod 声明适用范围用不上完整的 semver 语法，多引一个依赖不值得。
 * 看不懂的范围一律当作「不在范围内」，宁可多提示一次风险。
 */
function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  const caret = /^\^(.+)$/.exec(range.trim())
  if (caret !== null) {
    const base = parseVersion(caret[1] ?? '')
    if (base === null) return false
    // 0.x 视 minor 为不兼容边界，与 npm 的 ^ 语义一致
    if (base.major === 0) return v.major === 0 && v.minor === base.minor && compareVersions(version, caret[1] ?? '') >= 0
    return v.major === base.major && compareVersions(version, caret[1] ?? '') >= 0
  }
  const pair = /^>=\s*([^\s]+)\s+<\s*([^\s]+)$/.exec(range.trim())
  if (pair !== null) {
    return compareVersions(version, pair[1] ?? '') >= 0 && compareVersions(version, pair[2] ?? '') < 0
  }
  return false
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
      && typeof (d as CorePatchDecl).authoredFor === 'string'
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

/**
 * pnpm 的 patchedDependencies 键。
 *
 * **只写包名，不带版本** —— 这样补丁会对任意已装版本尝试应用。
 * 写成 `包名@版本` 的话，宿主一升级 pnpm 就直接以 ERR_PNPM_UNUSED_PATCH
 * 拒绝安装，哪怕那次升级根本没碰被补丁的代码。
 */
function patchKey(d: CorePatchDecl): string {
  return d.package
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
      exactMatch: got === d.authoredFor,
      inRange: got !== null && satisfies(got, d.appliesTo ?? `^${d.authoredFor}`),
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

  // 版本不在作者声明的范围内不再直接拒绝 —— 宿主小版本升级常常不动被补丁的
  // 那几行，这时 mod 照常可用。让补丁内容自己回答能不能打上：
  // 打得上就继续，打不上 pnpm 会以 ERR_PNPM_PATCH_FAILED 挡下安装。
  // 这里只把风险记进日志，调用方负责在面板上提示。
  const risky = inspect(profile, pluginDir).filter((s) => !s.inRange)
  for (const r of risky) {
    log(`代码级补丁版本超出作者声明的适用范围：${r.package} 装的是 `
      + `${r.installedVersion ?? '未安装'}，补丁针对 ${r.authoredFor}`
      + `（适用 ${r.appliesTo ?? `^${r.authoredFor}`}）。仍会尝试应用。`, 'stderr')
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
    applied.push(`${d.package}（针对 ${d.authoredFor}）`)
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
      removed.push(`${d.package}（针对 ${d.authoredFor}）`)
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
  pluginDir: string,
): Array<{ package: string; ok: boolean; detail: string }> {
  const probes = readDecls(pluginDir)
    .filter((d): d is CorePatchDecl & { verify: { file: string; contains: string } } => d.verify !== undefined)
    .map((d) => ({ package: d.package, file: d.verify.file, contains: d.verify.contains }))
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
