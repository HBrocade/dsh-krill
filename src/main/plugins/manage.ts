/**
 * 插件的安装 / 卸载 / 禁用，以及安装后的识别闭环。
 *
 * 两条设计上的硬规矩：
 *
 *  1. **装可以热，卸不能热。** 安装默认走注入器的运行时注入（免重启）；
 *     卸载与禁用一律「标记 + 重启」—— 热卸载留残留（僵尸工具、webserver
 *     孤儿路由、profile patch 里永久累积的 disabled 条目），注入器作者自己
 *     在源码注释里记过这些坑。
 *  2. **「让 dsh 识别到」是安装的一部分。** 文件落盘、junction 建好都不等于
 *     dsh 认到了。装完自动跑识别闭环，失败时报出**卡在哪一步**，
 *     而不是笼统一句「安装失败」。
 */
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync,
  statSync, lstatSync, symlinkSync, readlinkSync,
} from 'node:fs'
import { join, basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { stringify } from 'yaml'
import { locateDsh } from '../backend/locate.ts'
import { log } from '../backend/log-ring.ts'
import { profilesRoot, readManifest } from '../update/plugins.ts'
import * as injector from './injector.ts'
import * as patch from './patch.ts'
import * as corePatch from './core-patch.ts'
import { desktopPluginsRoot } from './inventory.ts'

/** 本地别名，避免和 inventory 的导出在下面混用时看不清来源 */
const desktopPluginsRootLocal = desktopPluginsRoot
import type { InstallOutcome, RecognitionStep, PluginChannel } from '@shared/ipc'

const DEFAULT_PROFILE = 'web'

// ─────────────────────────────────────────────────────────────────────────────
// dsh plugin 命令封装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 跑 `dsh plugin --profile <p> <args>`。
 *
 * 官方装配必须走它 —— 它是 pnpm 转发器，装完会按「已安装状态」回填
 * `dsh.profile.bundles`。自己改 manifest 会漏掉这步回填。
 */
export function runDshPlugin(
  profile: string,
  args: readonly string[],
  onOutput?: (line: string) => void,
): Promise<string> {
  const located = locateDsh()
  if (located === null) throw new Error('找不到 dsh，无法执行 plugin 命令')
  const argv = [located.bin, 'plugin', '--profile', profile, ...args]

  return new Promise((resolve, reject) => {
    const proc = spawn(
      located.nodeBin,
      located.needsElectronAsNode ? ['--no-warnings', ...argv] : argv,
      {
        env: { ...process.env, ...(located.needsElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const tail: string[] = []
    const take = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() === '') continue
        tail.push(line)
        if (tail.length > 60) tail.shift()
        onOutput?.(line)
        log(line, 'stdout')
      }
    }
    proc.stdout?.on('data', take)
    proc.stderr?.on('data', take)
    proc.on('error', (err) => { reject(new Error(`无法启动 dsh plugin：${err.message}`)) })
    proc.on('exit', (code) => {
      if (code === 0) resolve(tail.join('\n'))
      else reject(new Error(`dsh plugin 退出码 ${code}。最后几行：\n${tail.slice(-10).join('\n')}`))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 来源物化：把 spec 落成一个本地目录
// ─────────────────────────────────────────────────────────────────────────────

function isTarball(p: string): boolean {
  return /\.(tgz|tar\.gz)$/i.test(p)
}

/** 解压 tarball 到目标目录（strip 掉 npm 包惯例的 package/ 顶层）。 */
function extractTarball(file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true })
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', file, '-C', into, '--strip-components=1'], { windowsHide: true })
    let err = ''
    proc.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    proc.on('error', (e) => { reject(new Error(`解压失败：${e.message}`)) })
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压退出码 ${code}：${err.slice(0, 300)}`))
    })
  })
}

/**
 * 把安装来源变成一个本地目录。
 *
 * 支持：本地目录 / 本地 .tgz / http(s) 的 .tgz。
 * 下载与解压统一落到 `~/.dsh/desktop-plugins/<包名>/` —— 桌面端自管，不污染 profile。
 */
export async function materialize(spec: string): Promise<string> {
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('安装来源不能为空')

  if (/^https?:\/\//i.test(trimmed)) {
    if (!isTarball(trimmed)) {
      throw new Error('目前只支持 .tgz 链接。GitHub 仓库请先下载 Release 里的 tgz，或克隆到本地后用目录安装。')
    }
    const res = await fetch(trimmed)
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const tmp = join(tmpdir(), `krill-plugin-${String(Date.now())}.tgz`)
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    const dir = await unpackInto(tmp, basename(trimmed).replace(/\.(tgz|tar\.gz)$/i, ''))
    rmSync(tmp, { force: true })
    return dir
  }

  const abs = isAbsolute(trimmed) ? trimmed : resolvePath(homedir(), trimmed)
  if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`)
  if (isTarball(abs)) {
    return unpackInto(abs, basename(abs).replace(/\.(tgz|tar\.gz)$/i, ''))
  }
  if (!statSync(abs).isDirectory()) throw new Error(`既不是目录也不是 .tgz：${abs}`)
  if (!existsSync(join(abs, 'package.json'))) {
    throw new Error(`${abs} 里没有 package.json，不像是一个插件包`)
  }
  // 本地目录直接用，不复制 —— 开发中的插件要能改完立刻重新注入
  return abs
}

async function unpackInto(tarball: string, fallbackName: string): Promise<string> {
  const staging = join(tmpdir(), `krill-unpack-${String(Date.now())}`)
  await extractTarball(tarball, staging)
  let name = fallbackName
  try {
    const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name !== '') name = pkg.name
  } catch {
    throw new Error('解压后没找到 package.json，这个 tarball 不像插件包')
  }
  const target = join(desktopPluginsRoot(), ...name.split('/'))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(join(target, '..'), { recursive: true })
  // 用 rename 而不是逐文件拷贝；跨设备时回落到 cp -R
  try {
    const { renameSync } = await import('node:fs')
    renameSync(staging, target)
  } catch {
    await new Promise<void>((res, rej) => {
      const p = spawn('cp', ['-R', staging, target], { windowsHide: true })
      p.on('exit', (c) => { c === 0 ? res() : rej(new Error(`拷贝失败，退出码 ${String(c)}`)) })
      p.on('error', rej)
    })
    rmSync(staging, { recursive: true, force: true })
  }
  return target
}

/**
 * 给插件包挂一个指向 dsh 运行时 node_modules 的符号链接。
 *
 * 插件的产物 import 的是 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 这些，
 * 而它自己没有依赖树。注入器建的是 junction，Node 解析符号链接时用**真实路径**，
 * 于是从插件包的原始位置往上找 —— 找不到任何 dsh 依赖。
 *
 * profile 的 node_modules 也救不了：那里的布局是别名铺平的
 * （`cordis` 这个目录里装的其实是 `@deepseek-ai/cordis`），
 * `@deepseek-ai/cordis` 这个说明符在那里根本不存在。
 *
 * 运行时那棵树才是正常布局，所以直接把整个 node_modules 链过来，
 * 一个链接解决全部依赖，也不必逐个解析 peerDependencies。
 */
function linkRuntimeDeps(pluginDir: string): void {
  const located = locateDsh()
  if (located === null) return
  const runtimeModules = resolvePath(dirname(located.bin), '..', '..', '..')
  const target = join(pluginDir, 'node_modules')
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink()) {
      if (readlinkSync(target) === runtimeModules) return
      rmSync(target, { force: true })
    } else {
      // 已有真实的 node_modules 目录就别碰 —— 那是插件自带的
      return
    }
  } catch { /* 不存在，往下建 */ }
  try {
    symlinkSync(runtimeModules, target, 'dir')
    log(`已为 ${pluginDir} 链接运行时依赖 → ${runtimeModules}`)
  } catch (e) {
    log(`链接运行时依赖失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
  }
}

function readPackageName(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name !== '') return pkg.name
  } catch { /* 下面统一报错 */ }
  throw new Error(`${dir}/package.json 读不到 name 字段`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 识别闭环
// ─────────────────────────────────────────────────────────────────────────────

function step(
  id: RecognitionStep['step'], label: string,
  ok: boolean, detail: string | null, skipped = false,
): RecognitionStep {
  return { step: id, label, ok, skipped, detail }
}

/**
 * 装完验一遍 dsh 到底认没认到。
 *
 * 每一步都可能因为不同原因断，报出**具体哪一步**才有诊断价值 ——
 * 「装了但没反应」的成因太多（包名解析不到、patch 格式不对、
 * peerDeps 解析失败、client bundle 没构建），笼统报错等于没报。
 */
export async function verifyRecognition(
  name: string, dir: string, profile: string,
): Promise<RecognitionStep[]> {
  const steps: RecognitionStep[] = []

  // 1. 能否从 profile 的 node_modules 解析到
  const nm = join(profilesRoot(), profile, 'node_modules', ...name.split('/'))
  const resolvable = existsSync(join(nm, 'package.json'))
  steps.push(step('resolvable', `${profile} 的 node_modules 里能解析到 ${name}`,
    resolvable, resolvable ? nm : `${nm} 不存在 —— junction / 链接没建成`))

  // 2. 注入器视角：条目在不在、fiber 活没活
  try {
    const listed = await injector.list()
    const hit = listed.entries.find((e) => e.name === name || e.id === name)
    const active = hit?.active === true
    steps.push(step('injector-active', '注入器 /list 里存在且 active',
      active,
      hit === undefined
        ? '注入器清单里没有这个包 —— loader.create 可能失败了'
        : active ? null : 'fiber 未活跃，看注入器返回的错'))
  } catch (e) {
    steps.push(step('injector-active', '注入器 /list 里存在且 active',
      false, `注入器不可用：${e instanceof Error ? e.message : String(e)}`, true))
  }

  // 3. 官方视角复核。pluginInventory 是 typert 生成的 Remote，不在 RpcMethodMap 里，
  //    走的是另一条 wire 通道，这里拿不到就跳过，不当作失败。
  steps.push(step('inventory-active', '官方 pluginInventory 复核',
    false, 'pluginInventory 是 Remote 通道，桌面端尚未接入，本步跳过', true))

  // 4. 能力级验证：有 client 半边的包，至少要能确认 client bundle 构建过；
  //    工具/UI 是否真的注册进去，需要一个会话级探针，尚未实现。
  let capOk = true
  let capDetail: string | null = '无 client 声明，跳过 client bundle 检查；工具级探针尚未实现'
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { client?: unknown }
    }
    if (pkg.dsh?.client !== undefined && pkg.dsh.client !== null) {
      capOk = existsSync(join(dir, 'lib', 'client.js'))
      capDetail = capOk
        ? 'client bundle 存在'
        : '声明了 dsh.client 却没有 lib/client.js —— 装上也不会有 UI，需要在包目录里跑一次 client 构建'
    }
  } catch {
    capOk = false
    capDetail = '读不到包的 package.json'
  }
  steps.push(step('capability', '声明的能力确实就位', capOk, capDetail))

  return steps
}

// ─────────────────────────────────────────────────────────────────────────────
// 安装
// ─────────────────────────────────────────────────────────────────────────────

export async function install(
  args: { spec: string; channel: 'injected' | 'official'; profile?: string },
  onOutput?: (line: string) => void,
): Promise<InstallOutcome> {
  const profile = args.profile ?? DEFAULT_PROFILE
  const dir = await materialize(args.spec)
  const name = readPackageName(dir)
  linkRuntimeDeps(dir)
  log(`安装插件 ${name}（来源 ${dir}，通道 ${args.channel}）`)

  // 互斥检查：两条通道对同一个包并存会造出重复 loader entry id，dsh 启动即崩
  const manifest = readManifest(profile)
  const alreadyOfficial = manifest !== null && Object.hasOwn(manifest.dependencies, name)
  if (args.channel === 'injected' && alreadyOfficial) {
    throw new Error(
      `${name} 已经是官方装配态。两条通道对同一个包互斥 —— 同时存在会造出重复 `
      + 'loader entry id，dsh 启动即崩。要改走热注入，请先卸载官方装配态。',
    )
  }
  if (args.channel === 'official') {
    try {
      const listed = await injector.list()
      if (listed.entries.some((e) => e.name === name || e.id === name)) {
        throw new Error(
          `${name} 当前是运行时注入态。先重启后端让注入态清掉，再走官方装配 —— `
          + '两者并存会造出重复 loader entry id。',
        )
      }
    } catch (e) {
      // 注入器不可用时无法核对，放行但记录
      if (e instanceof Error && e.message.includes('重复 loader')) throw e
      log('注入器不可用，跳过通道互斥核对')
    }
  }

  // 代码级补丁打在 dsh 运行时上（不是 profile —— 核心包住在运行时里）。
  // 首次会把运行时复制一份到 userData，之后 locate.ts 优先用那份。
  const patched = await corePatch.apply(dir, onOutput)
  const failed = patched.filter((r) => !r.ok)
  if (failed.length > 0) {
    throw new Error(
      `${String(failed.length)} 处代码级补丁未能应用，已中止安装：\n`
      + failed.map((r) => `  ${r.package}：${r.detail}`).join('\n'),
    )
  }
  if (patched.length > 0) {
    onOutput?.(`${String(patched.length)} 处代码级补丁已应用并校验通过，重启后端后生效`)
  }

  if (args.channel === 'injected') {
    const msg = await injector.inject(dir)
    onOutput?.(msg)
  } else {
    await runDshPlugin(profile, ['add', dir], onOutput)
  }

  const steps = await verifyRecognition(name, dir, profile)
  const recognized = steps.every((s) => s.ok || s.skipped)
  log(`安装收尾识别闭环：${recognized ? '全部通过' : '有步骤未通过'}`)
  for (const s of steps) {
    if (!s.ok && !s.skipped) log(`  未通过 · ${s.label}：${s.detail ?? '无详情'}`, 'stderr')
  }

  return { name, channel: args.channel as PluginChannel, steps, recognized }
}

// ─────────────────────────────────────────────────────────────────────────────
// 卸载：标记 + 四处清理 + 重启生效
// ─────────────────────────────────────────────────────────────────────────────

function injectorRegistryPath(): string {
  return join(homedir(), '.dsh', 'super-injector', 'registry.json')
}

/**
 * 从注入器的持久化清单里移除条目。
 *
 * **这是最容易漏的一处** —— 不清它，重启后注入器会自动把包恢复注入，
 * 表现成「卸载了又回来」。
 */
function removeFromInjectorRegistry(name: string): [boolean, string] {
  const file = injectorRegistryPath()
  if (!existsSync(file)) return [true, '注入器清单不存在，跳过']
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return [false, `注入器清单解析失败，未改动：${e instanceof Error ? e.message : String(e)}`]
  }
  const backup = `${file}.bak-${String(Date.now())}`
  copyFileSync(file, backup)

  const matches = (v: unknown): boolean => {
    if (typeof v === 'string') return v === name || v.includes(name)
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return o['name'] === name || o['id'] === name
        || (typeof o['dir'] === 'string' && o['dir'].includes(name))
    }
    return false
  }

  let removed = 0
  if (Array.isArray(doc)) {
    const kept = doc.filter((e) => { const m = matches(e); if (m) removed += 1; return !m })
    writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8')
  } else if (doc !== null && typeof doc === 'object') {
    const o = doc as Record<string, unknown>
    for (const key of Object.keys(o)) {
      if (Array.isArray(o[key])) {
        const arr = o[key] as unknown[]
        const kept = arr.filter((e) => { const m = matches(e); if (m) removed += 1; return !m })
        o[key] = kept
      } else if (matches(o[key]) || key === name) {
        delete o[key]; removed += 1
      }
    }
    writeFileSync(file, JSON.stringify(o, null, 2), 'utf8')
  } else {
    return [false, '注入器清单格式不认识，未改动']
  }
  return removed === 0
    ? [true, '注入器清单里没有该条目']
    : [true, `已移除 ${removed} 条（备份 ${backup}）`]
}

/**
 * 从 patch 里删掉该 id 的全部条目（含卸载残留的 disabled）。
 * @returns [是否成功, 说明]。**拒绝执行也算不成功** —— 报成成功会让用户
 *   以为清理干净了，重启后却发现条目还在。
 */
function removeFromPatch(profile: string, name: string): [boolean, string] {
  const file = patch.patchPath(profile)
  if (!existsSync(file)) return [true, 'patch 文件不存在，跳过']
  if (patch.hasCustomTags(readFileSync(file, 'utf8'))) {
    return [false, 'patch 含自定义 YAML 标签，拒绝自动改写 —— 请手动清理该 id 的条目']
  }
  let entries: patch.PatchEntry[]
  try { entries = patch.read(profile) } catch (e) {
    return [false, `patch 解析失败，未改动：${e instanceof Error ? e.message : String(e)}`]
  }
  const shortId = name.split('/').pop() ?? name
  const kept = entries.filter((e) => e.id !== shortId && e.id !== name && e.name !== name)
  if (kept.length === entries.length) return [true, 'patch 里没有该条目']
  const backup = `${file}.bak-${String(Date.now())}`
  copyFileSync(file, backup)
  writeFileSync(file, kept.length === 0 ? '[]\n' : stringify(kept), 'utf8')
  return [true, `已删除 ${entries.length - kept.length} 条（备份 ${backup}）`]
}

/** 删掉 profile node_modules 里的链接/目录。 */
function removeNodeModulesLink(profile: string, name: string): [boolean, string] {
  const p = join(profilesRoot(), profile, 'node_modules', ...name.split('/'))
  // 符号链接指向的目标可能已不存在，existsSync 会跟随链接而返回 false，
  // 所以用 lstatSync 判断「链接本身在不在」
  let present = false
  try { lstatSync(p); present = true } catch { present = false }
  if (!present) return [true, '链接不存在，跳过']
  rmSync(p, { recursive: true, force: true })
  return [true, `已删除 ${p}`]
}

export interface UninstallReport {
  name: string
  /** 四处清理各自的结果，逐条如实报 */
  steps: Array<{ label: string; detail: string; ok: boolean }>
  restartRequired: true
}

/**
 * 卸载：只清持久化层，**不动运行中的 fiber**，然后要求重启。
 *
 * 明确不调注入器的热卸载 —— 那正是残留的来源。
 */
export async function uninstall(
  args: { name: string; profile?: string },
  onOutput?: (line: string) => void,
): Promise<UninstallReport> {
  const profile = args.profile ?? DEFAULT_PROFILE
  const { name } = args
  log(`卸载插件 ${name}（标记 + 清理，重启后生效）`)
  const steps: UninstallReport['steps'] = []

  const manifest = readManifest(profile)
  if (manifest !== null && Object.hasOwn(manifest.dependencies, name)) {
    try {
      await runDshPlugin(profile, ['remove', name], onOutput)
      steps.push({ label: 'profile 依赖与 bundles', detail: 'dsh plugin remove 执行成功', ok: true })
    } catch (e) {
      steps.push({
        label: 'profile 依赖与 bundles',
        detail: e instanceof Error ? e.message : String(e), ok: false,
      })
    }
  } else {
    steps.push({ label: 'profile 依赖与 bundles', detail: '不在 dependencies 里，跳过', ok: true })
  }

  // 代码级补丁也要撤 —— 不撤的话宿主代码一直带着改动，
  // 而插件已经不在了，是最难排查的一种残留
  const dirs = [join(desktopPluginsRootLocal(), ...name.split('/'))]
  for (const d of dirs) {
    if (!existsSync(join(d, 'package.json'))) continue
    try {
      const reverted = await corePatch.revert(d, onOutput)
      const bad = reverted.filter((r) => !r.ok)
      steps.push({
        label: '代码级补丁',
        detail: reverted.length === 0
          ? '该插件没有代码级补丁'
          : bad.length === 0
            ? `已撤销 ${String(reverted.length)} 处，重启后端后生效`
            : `${String(bad.length)}/${String(reverted.length)} 处撤销失败：`
              + bad.map((r) => `${r.package} ${r.detail}`).join('；'),
        ok: bad.length === 0,
      })
    } catch (e) {
      steps.push({ label: '代码级补丁', detail: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  for (const [label, fn] of [
    ['注入器 registry.json', () => removeFromInjectorRegistry(name)],
    ['cordis.patch.yml 条目', () => removeFromPatch(profile, name)],
    ['node_modules 链接', () => removeNodeModulesLink(profile, name)],
  ] as const) {
    try {
      const [ok, detail] = fn()
      steps.push({ label, detail, ok })
    } catch (e) {
      steps.push({ label, detail: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  for (const s of steps) log(`  ${s.ok ? '✓' : '✗'} ${s.label}：${s.detail}`, s.ok ? 'app' : 'stderr')
  return { name, steps, restartRequired: true }
}

/** 禁用 / 启用：写 patch 的 disabled 标记，同样要重启生效。 */
export function setDisabled(args: { name: string; disabled: boolean; profile?: string }): string {
  const profile = args.profile ?? DEFAULT_PROFILE
  const file = patch.patchPath(profile)
  if (existsSync(file) && patch.hasCustomTags(readFileSync(file, 'utf8'))) {
    throw new Error('patch 含自定义 YAML 标签，拒绝自动改写 —— 请手动增删 disabled 条目')
  }
  const shortId = args.name.split('/').pop() ?? args.name
  const entries = patch.read(profile)
  const idx = entries.findIndex((e) => e.id === shortId || e.id === args.name)

  if (args.disabled) {
    if (idx >= 0) entries[idx] = { ...entries[idx], disabled: true }
    else entries.push({ id: shortId, disabled: true })
  } else {
    if (idx < 0) return '本来就没有禁用条目'
    const e = entries[idx]!
    // 条目只是为了禁用而存在的话，整条删掉；带别的配置就只去掉 disabled
    const rest = Object.keys(e).filter((k) => k !== 'id' && k !== 'disabled')
    if (rest.length === 0) entries.splice(idx, 1)
    else entries[idx] = { ...e, disabled: false }
  }

  if (existsSync(file)) copyFileSync(file, `${file}.bak-${String(Date.now())}`)
  mkdirSync(join(profilesRoot(), profile), { recursive: true })
  writeFileSync(file, entries.length === 0 ? '[]\n' : stringify(entries), 'utf8')
  const verb = args.disabled ? '已禁用' : '已启用'
  log(`${verb} ${args.name}（重启后生效）`)
  return `${verb}，重启后端后生效`
}
