/**
 * 代码级补丁（创意工坊式插件的核心能力）。
 *
 * 有些插件光靠挂载做不到 —— 它需要宿主自己的代码配合：插件想接的那个缝
 * 在已发布的核心包里，而那些包不提供扩展点。这类插件只能改宿主的代码。
 *
 * **补丁打在 dsh 运行时上，不是 profile 上。** 这一点绕了个弯才搞清：
 * profile 的 node_modules 里只有插件自己（实测只有注入器一个包），
 * 核心包住在内嵌运行时里 —— `node` 解析 `@deepseek-ai/dsh-llm` 落在
 * `.app/Contents/Resources/dsh/node_modules/`。所以往 profile 写
 * pnpm 的 `patchedDependencies` 一个字节都改不到它们。
 *
 * 而 app bundle 里的那份不能改（应用更新会覆盖，签名后也未必可写），
 * 所以补丁落在 **userData 的可写副本**上 —— locate.ts 的优先级本来就是
 * `DSH_BIN > userData > 内嵌 > PATH`，副本一旦存在就会被优先使用。
 *
 * 应用方式是直接 `patch -p1`，不绕 pnpm：运行时那棵树是 npm 装出来的，
 * 没有 pnpm 工程结构，而 `patch` 天然可逆（`patch -R`）。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../backend/log-ring.ts'
import { locateDsh, userDshRoot, readDshVersion } from '../backend/locate.ts'
import { compareVersions, parseVersion } from '@shared/semver'

/** 插件包在自己的 package.json 里用 `krill.corePatches` 声明。 */
export interface CorePatchDecl {
  package: string
  /** 作者针对哪个版本写的 —— 仅用于展示与判断陈旧度，不作为门禁 */
  authoredFor: string
  /** 作者认为适用的 semver 范围；超出只提示风险，仍会尝试 */
  appliesTo?: string
  file: string
  reason?: string
  /**
   * 回读探针：装完后在目标包的哪个文件里应该能搜到什么串。
   *
   * 「补丁被应用了」与「补丁产生了预期效果」是两件事。探针要挑该补丁
   * **独有**的符号。实测踩过一次：拿一个被补丁**新增**的函数名去探另一个
   * 只是**导入**它的包，得到 0 命中、误判成补丁失败。探针必须挑目标包里
   * 确实会出现的那个串。
   */
  verify?: { file: string; contains: string }
}

export interface CorePatchStatus extends CorePatchDecl {
  /** 运行时里实际装的版本 */
  installedVersion: string | null
  exactMatch: boolean
  inRange: boolean
  /** 补丁当前是否已应用（靠探针回读判断，不靠记账） */
  applied: boolean
}

/** 极简 semver 范围判断，只支持 `^x.y.z` 与 `>=a <b`。看不懂一律当作不在范围内。 */
function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  const caret = /^\^(.+)$/.exec(range.trim())
  if (caret !== null) {
    const base = parseVersion(caret[1] ?? '')
    if (base === null) return false
    if (base.major === 0) {
      return v.major === 0 && v.minor === base.minor && compareVersions(version, caret[1] ?? '') >= 0
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// 可写运行时副本
// ─────────────────────────────────────────────────────────────────────────────

/** 当前实际在用的运行时根目录（含 node_modules 的那一层）。 */
function activeRuntimeRoot(): string | null {
  const located = locateDsh()
  if (located === null) return null
  // bin 形如 <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
  return join(located.bin, '..', '..', '..', '..', '..')
}

export function writableRuntimeRoot(): string {
  return userDshRoot()
}

/**
 * 确保有一份**可写**的运行时。
 *
 * app bundle 里那份不能改：应用更新会整个覆盖，改动会静默消失；
 * 而且签名分发时它可能只读。所以第一次打补丁时把它整份复制到 userData
 * （约 216MB），此后 locate.ts 会优先用这份。
 *
 * @returns 可写运行时的根目录
 */
export function ensureWritableRuntime(onOutput?: (line: string) => void): string {
  const target = writableRuntimeRoot()
  if (existsSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    return target
  }
  const source = activeRuntimeRoot()
  if (source === null) throw new Error('找不到 dsh 运行时，无法准备可写副本')
  onOutput?.('首次打补丁：正在把 dsh 运行时复制到应用数据目录（约 216MB，只做一次）…')
  log(`复制运行时 ${source} → ${target}`)
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true, dereference: true })
  const got = readDshVersion(target)
  if (got === null) throw new Error(`复制完成但读不到版本号，副本可能不完整：${target}`)
  onOutput?.(`运行时副本已就绪（${got}）`)
  return target
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────────────────────

/** 靠探针回读判断补丁在不在 —— 比自己记一本账可靠，账本会和现实脱节。 */
function probeApplied(root: string, d: CorePatchDecl): boolean {
  if (d.verify === undefined) return false
  const f = join(root, 'node_modules', ...d.package.split('/'), d.verify.file)
  try {
    return readFileSync(f, 'utf8').includes(d.verify.contains)
  } catch {
    return false
  }
}

export function inspect(pluginDir: string): CorePatchStatus[] {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []
  const root = activeRuntimeRoot()
  return decls.map((d) => {
    const got = root === null ? null : readPackageVersion(root, d.package)
    return {
      ...d,
      installedVersion: got,
      exactMatch: got === d.authoredFor,
      inRange: got !== null && satisfies(got, d.appliesTo ?? `^${d.authoredFor}`),
      applied: root !== null && probeApplied(root, d),
    }
  })
}

function readPackageVersion(root: string, name: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 应用 / 撤销
// ─────────────────────────────────────────────────────────────────────────────

function runPatch(cwd: string, patchFile: string, reverse: boolean): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const args = ['-p1', '--no-backup-if-mismatch', ...(reverse ? ['-R'] : []), '-i', patchFile]
    const proc = spawn('patch', args, { cwd, windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('error', (e) => { resolve({ ok: false, out: `无法启动 patch：${e.message}` }) })
    proc.on('exit', (code) => { resolve({ ok: code === 0, out: out.trim() }) })
  })
}

export interface PatchOutcome {
  package: string
  ok: boolean
  detail: string
}

export async function apply(
  pluginDir: string,
  onOutput?: (line: string) => void,
): Promise<PatchOutcome[]> {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []

  const root = ensureWritableRuntime(onOutput)
  const results: PatchOutcome[] = []

  for (const d of decls) {
    const pkgDir = join(root, 'node_modules', ...d.package.split('/'))
    const patchFile = join(pluginDir, d.file)
    if (!existsSync(pkgDir)) {
      results.push({ package: d.package, ok: false, detail: `运行时里没有这个包：${pkgDir}` })
      continue
    }
    if (!existsSync(patchFile)) {
      results.push({ package: d.package, ok: false, detail: `插件声明了补丁但文件不存在：${patchFile}` })
      continue
    }
    // 已经打过就跳过 —— patch 重复应用会失败，那种失败没有诊断价值
    if (probeApplied(root, d)) {
      results.push({ package: d.package, ok: true, detail: '已是打过补丁的状态，跳过' })
      continue
    }

    const got = readPackageVersion(root, d.package)
    if (got !== null && !satisfies(got, d.appliesTo ?? `^${d.authoredFor}`)) {
      // 超范围不拒绝 —— 宿主升级往往不动被补丁的那几行。让补丁自己回答。
      log(`补丁版本超出适用范围：${d.package} 运行时是 ${got}，补丁针对 ${d.authoredFor}。仍尝试应用。`, 'stderr')
      onOutput?.(`⚠ ${d.package}：运行时 ${got} 超出补丁声明的适用范围，仍尝试应用`)
    }

    const r = await runPatch(pkgDir, patchFile, false)
    const verified = r.ok && probeApplied(root, d)
    results.push({
      package: d.package,
      ok: verified,
      detail: !r.ok
        ? `打补丁失败：${r.out.slice(0, 300)}`
        : verified
          ? '已应用并回读校验通过'
          : `patch 报成功但回读校验没找到 ${d.verify?.contains ?? '预期标记'} —— 可能打到了错误位置`,
    })
    onOutput?.(`${verified ? '✓' : '✗'} ${d.package}：${results[results.length - 1]?.detail ?? ''}`)
  }
  return results
}

export async function revert(
  pluginDir: string,
  onOutput?: (line: string) => void,
): Promise<PatchOutcome[]> {
  const decls = readDecls(pluginDir)
  if (decls.length === 0) return []
  const root = writableRuntimeRoot()
  if (!existsSync(root)) return []

  const results: PatchOutcome[] = []
  for (const d of decls) {
    const pkgDir = join(root, 'node_modules', ...d.package.split('/'))
    const patchFile = join(pluginDir, d.file)
    if (!existsSync(pkgDir) || !existsSync(patchFile)) continue
    if (!probeApplied(root, d)) {
      results.push({ package: d.package, ok: true, detail: '本来就没打，跳过' })
      continue
    }
    const r = await runPatch(pkgDir, patchFile, true)
    const gone = !probeApplied(root, d)
    results.push({
      package: d.package,
      ok: r.ok && gone,
      detail: r.ok && gone ? '已撤销' : `撤销失败：${r.out.slice(0, 300)}`,
    })
    onOutput?.(`${r.ok && gone ? '✓' : '✗'} 撤销 ${d.package}`)
  }
  return results
}

/** 把 userData 的运行时副本整个删掉，回到用内嵌那份。面板上的"重置"用。 */
export function resetRuntime(): void {
  const root = writableRuntimeRoot()
  if (!existsSync(root)) return
  rmSync(root, { recursive: true, force: true })
  log(`已删除可写运行时副本 ${root}，下次启动回到内嵌版本`)
}

