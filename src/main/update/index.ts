/**
 * 更新中心编排：四类检测汇成一份状态，定时刷新，变化广播给界面与托盘。
 *
 * 四类互不阻塞 —— 任何一类失败只污染自己那一格，其余照常出结果。
 * 网络断了不该让整个面板空白。
 */
import { clearCache } from './registry.ts'
import * as cli from './cli.ts'
import * as plugins from './plugins.ts'
import * as sourceRepo from './source-repo.ts'
import * as appUpdate from './app.ts'
import { log } from '../backend/log-ring.ts'
import { loadConfig } from '../config/store.ts'
import { desktopPluginsRoot } from '../plugins/inventory.ts'
import * as corePatch from '../plugins/core-patch.ts'
import * as manage from '../plugins/manage.ts'
import * as supervisor from '../backend/supervisor.ts'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateReport } from '@shared/ipc'

let report: UpdateReport = {
  checkedAt: null,
  checking: false,
  cli: {
    current: null, latest: null, upgradable: false, error: null,
    upgrading: false, upgradeStep: null, atRiskPatches: [],
  },
  plugins: [],
  sourceRepo: { path: '', exists: false, branch: null, behind: 0, ahead: 0, dirty: false, error: null },
  app: { configured: false, current: '0.0.0', latest: null, status: 'idle', progressPercent: null, error: null },
}

const listeners = new Set<(r: UpdateReport) => void>()
let timer: NodeJS.Timeout | null = null
let inFlight: Promise<UpdateReport> | null = null
let upgradeInFlight: Promise<string> | null = null

export function getReport(): UpdateReport { return structuredClone(report) }

export function onChange(fn: (r: UpdateReport) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit(): void {
  const snap = getReport()
  for (const fn of listeners) {
    try { fn(snap) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

function patch(next: Partial<UpdateReport>): void {
  report = { ...report, ...next }
  emit()
}

/**
 * 跑一轮全量检查。并发已在飞行时直接复用同一个 Promise ——
 * 面板上连点「立即检查」不该叠出多轮请求。
 */
export function checkAll(options: { force?: boolean; reason?: string } = {}): Promise<UpdateReport> {
  if (inFlight !== null) {
    log(`更新检查已在进行中，复用当前这轮（触发者：${options.reason ?? '未标注'}）`)
    return inFlight
  }
  inFlight = (async () => {
    log(`开始更新检查（触发：${options.reason ?? '未标注'}）`)
    patch({ checking: true })
    if (options.force === true) clearCache()

    const [cliResult, pluginResult, repoResult, appResult] = await Promise.all([
      cli.check(options).catch((e: unknown) => ({
        current: cli.currentVersion(), latest: null, upgradable: false,
        error: e instanceof Error ? e.message : String(e),
      })),
      plugins.check(options).catch(() => []),
      sourceRepo.check().catch((e: unknown) => ({
        path: loadConfig().sourceRepoPath, exists: false, branch: null,
        behind: 0, ahead: 0, dirty: false,
        error: e instanceof Error ? e.message : String(e),
      })),
      appUpdate.check().catch(() => appUpdate.snapshot()),
    ])

    patch({
      checking: false,
      checkedAt: Date.now(),
      // 瞬时的升级状态原样带过去 —— 定时检查可能正落在升级进行中
      cli: {
        ...cliResult,
        upgrading: report.cli.upgrading,
        upgradeStep: report.cli.upgradeStep,
        atRiskPatches: appliedCorePatches(),
      },
      plugins: pluginResult,
      sourceRepo: repoResult,
      app: appResult,
    })

    // 出错的检测项在 pendingCount 里也算 0 —— 不单独报出来的话，
    // 「检查失败」和「全部最新」在日志里长得一模一样，排查时会被误导。
    const errors: string[] = []
    if (cliResult.error !== null) errors.push(`dsh CLI: ${cliResult.error}`)
    if (repoResult.error !== null) errors.push(`源码仓库: ${repoResult.error}`)
    if (appResult.error !== null) errors.push(`App 自更新: ${appResult.error}`)
    for (const p of pluginResult) {
      if (p.error !== null && p.source === 'registry') errors.push(`插件 ${p.name}: ${p.error}`)
    }

    const n = pendingCount()
    const detail = [
      cliResult.upgradable ? `dsh ${cliResult.current} → ${cliResult.latest}` : null,
      repoResult.exists && repoResult.behind > 0 ? `源码仓库落后 ${repoResult.behind}` : null,
      pluginResult.filter((p) => p.upgradable).length > 0
        ? `${pluginResult.filter((p) => p.upgradable).length} 个插件可升级` : null,
    ].filter((x): x is string => x !== null)

    log(`更新检查完成：${n === 0 ? '无可更新项' : `${n} 项可更新`}`
      + (detail.length > 0 ? `（${detail.join('；')}）` : '')
      + (errors.length > 0 ? ` —— 另有 ${errors.length} 项检查失败` : ''),
      errors.length > 0 ? 'stderr' : 'app')
    for (const e of errors) log(`  检查失败 · ${e}`, 'stderr')
    return getReport()
  })().finally(() => { inFlight = null })
  return inFlight
}

/** 可更新项总数，托盘角标用。 */
export function pendingCount(): number {
  let n = 0
  if (report.cli.upgradable) n += 1
  n += report.plugins.filter((p) => p.upgradable).length
  if (report.app.status === 'available' || report.app.status === 'downloaded') n += 1
  if (report.sourceRepo.exists && report.sourceRepo.behind > 0) n += 1
  return n
}

/**
 * 扫出所有声明了代码级补丁的 mod。
 *
 * 目录布局是 `<root>/<name>` 或 `<root>/@scope/<name>`，所以只需要下探一层。
 */
function modsWithCorePatches(): Array<{ dir: string; name: string }> {
  const root = desktopPluginsRoot()
  if (!existsSync(root)) return []
  const out: Array<{ dir: string; name: string }> = []
  const scan = (base: string, rel: string, depth: number): void => {
    let names: string[]
    try { names = readdirSync(base) } catch { return }
    for (const n of names) {
      const d = join(base, n)
      const r = rel === '' ? n : `${rel}/${n}`
      if (existsSync(join(d, 'package.json'))) {
        if (corePatch.readDecls(d).length > 0) out.push({ dir: d, name: r })
      } else if (depth > 0) {
        scan(d, r, depth - 1)   // @scope/ 那一层
      }
    }
  }
  scan(root, '', 1)
  return out
}

/**
 * 当前**已应用**的代码级补丁。
 *
 * 升级运行时是 `npm install --prefix` 覆盖整棵树，这些补丁会被一并冲掉。
 * 面板据此决定要不要二次确认。
 */
function appliedCorePatches(): Array<{ plugin: string; package: string }> {
  const out: Array<{ plugin: string; package: string }> = []
  for (const m of modsWithCorePatches()) {
    for (const st of corePatch.inspect(m.dir)) {
      if (st.applied) out.push({ plugin: m.name, package: st.package })
    }
  }
  return out
}

/**
 * 升级后把每个 mod 的补丁重打一遍，贴不上的就地停用。
 *
 * dsh 的版本以官方为准，升级优先；插件跟不上就先靠边站。停用而不是卸载 ——
 * 插件里可能有用户自己的配置，停用可逆、卸载不可逆，删不删是用户的决定。
 *
 * 但**必须停用**，不能放着不管：补丁没了而 loader 行还在的话，插件 import 的
 * 正是补丁加进去的导出，后端不是「功能降级」而是启动即崩，整个 App 不可用。
 *
 * 停用前先 revert：半应用状态比没应用更难查。
 */
async function reconcileMods(
  mods: Array<{ dir: string; name: string }>,
  onOutput: (line: string) => void,
): Promise<string[]> {
  const removed: string[] = []
  for (const m of mods) {
    let outcomes: corePatch.PatchOutcome[]
    try {
      outcomes = await corePatch.apply(m.dir, onOutput)
    } catch (e) {
      outcomes = [{ package: '(全部)', ok: false, detail: e instanceof Error ? e.message : String(e) }]
    }
    const bad = outcomes.filter((o) => !o.ok)
    if (bad.length === 0) {
      if (outcomes.length > 0) {
        log(`${m.name}：${String(outcomes.length)} 处补丁已在新版本上重新应用`)
        // 之前因为不兼容被停用的，现在补丁贴上了就该自己回来 —— 否则用户得记住
        // 「我半年前停用过什么」，再手动去启用，而那时早忘了为什么停的
        try {
          const back = manage.setDisabled({ name: m.name, disabled: false })
          if (!back.startsWith('本来就没有')) {
            log(`${m.name} 重新启用：${back}`)
            onOutput(`✓ ${m.name} 与新版本兼容，已重新启用`)
          }
        } catch { /* 启用失败不该让整次升级失败 */ }
      }
      continue
    }
    // 半应用状态比没应用更难查 —— 先撤干净再卸
    try { await corePatch.revert(m.dir, onOutput) } catch { /* 尽力而为 */ }
    try {
      // 只停用，不替用户做卸载的决定 —— 插件里可能有他自己的配置与数据，
      // 停用是可逆的，卸载不是。面板会把「不兼容」说清楚，删不删由他定。
      manage.setDisabled({ name: m.name, disabled: true })
      removed.push(m.name)
      log(`${m.name} 与新版本不兼容，已停用：`
        + bad.map((b) => `${b.package} ${b.detail}`).join('；'), 'stderr')
      onOutput(`⚠ ${m.name} 与新版本不兼容，已停用（${String(bad.length)} 处补丁贴不上）`)
    } catch (e) {
      log(`${m.name} 不兼容且停用失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
      onOutput(`✗ ${m.name} 不兼容，且自动停用失败 —— 后端可能起不来，需要手动处理`)
    }
  }
  return removed
}

/**
 * 一键升级 dsh CLI。升级完不自动重启后端 —— 何时重启由用户决定。
 *
 * 重复调用复用同一次升级：面板切 tab 会让按钮重新可点，两次
 * `npm install --prefix` 同时往一个目录写会互相踩，装出一棵谁也说不清的树。
 *
 * @param args.confirm 有代码级补丁会被覆盖时必须为 true。这不是走过场 ——
 *   升级会停用贴不上的 mod，用户得先知道要付这个代价。
 */
export function upgradeCli(args: { confirm: boolean } = { confirm: false }): Promise<string> {
  if (upgradeInFlight !== null) return upgradeInFlight

  const latest = report.cli.latest
  if (latest === null) return Promise.reject(new Error('还没查到可用版本，先跑一次检查'))
  if (!report.cli.upgradable) return Promise.reject(new Error(`当前已是 ${report.cli.current}，无需升级`))

  const mods = modsWithCorePatches()
  const atRisk = appliedCorePatches()
  if (atRisk.length > 0 && !args.confirm) {
    const names = [...new Set(atRisk.map((a) => a.plugin))].join('、')
    return Promise.reject(new Error(
      `需要确认：升级可能会丢失插件。${names} 依赖 ${String(atRisk.length)} 处代码级补丁，`
      + '而升级会覆盖整棵运行时。升级后会自动重打一遍 —— 贴得上就继续用，'
      + '**贴不上的会被停用**（留着后端起不来）。停用后可以在插件面板里自行卸载，'
      + '或等它更新后重装。再点一次确认升级。',
    ))
  }

  patch({ cli: { ...report.cli, upgrading: true, upgradeStep: '正在启动 npm…' } })
  const step = (line: string): void => {
    patch({ cli: { ...report.cli, upgradeStep: line.slice(0, 200) } })
  }
  upgradeInFlight = cli.install(latest, step)
    .then(async (got) => {
      step('正在把 mod 的代码级补丁重打到新版本上…')
      const off = await reconcileMods(mods, step)
      patch({
        cli: {
          ...report.cli,
          current: got, upgradable: false,
          upgrading: false, upgradeStep: null,
          atRiskPatches: appliedCorePatches(),
        },
      })

      // 必须自己重启，不能只提示「重启后生效」。
      //
      // 换树是把目录整个 rename 掉的，而老进程还活着 —— 它的代码是旧版的，
      // 脚下的静态资源却已经是新版的。实测这个组合的表现是前端白屏加一句
      // `web boot: window.__ModuleLoader__ bootstrap facade is missing`：
      // 旧 host 不会给新前端注入引导。用户看到的是「升级完就坏了」，
      // 而日志里那句提示远在几十行之前，没人会把两件事联系起来。
      step('正在重启后端…')
      try {
        await supervisor.restart()
        step('✓ 后端已重启，新版本生效')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log(`升级后重启后端失败：${msg}`, 'stderr')
        step(`⚠ 升级完成，但后端重启失败：${msg} —— 请手动重启`)
      }
      return off.length === 0
        ? got
        : `${got}（${off.join('、')} 与新版本不兼容，已停用 —— 可在插件面板卸载，或等它更新后重装）`
    })
    .catch((e: unknown) => {
      patch({ cli: { ...report.cli, upgrading: false, upgradeStep: null } })
      throw e
    })
    .finally(() => { upgradeInFlight = null })
  return upgradeInFlight
}

export async function pullSourceRepo(): Promise<string> {
  const summary = await sourceRepo.pull()
  patch({ sourceRepo: await sourceRepo.check() })
  return summary
}

export const downloadApp = appUpdate.download
export const installApp = appUpdate.install

/**
 * 启动定时器。间隔 <= 0 表示只保留手动检查。
 * 首轮延后 20 秒：启动瞬间要让后端先起来、窗口先出来，别和它们抢带宽和 CPU。
 */
export function start(): void {
  appUpdate.subscribe(() => { patch({ app: appUpdate.snapshot() }) })

  const hours = loadConfig().updateIntervalHours
  setTimeout(() => { void checkAll({ reason: '启动后首轮' }) }, 20_000)
  if (hours <= 0) {
    log('更新定时检查已关闭（间隔 <= 0），仅保留手动检查')
    return
  }
  const ms = Math.max(1, hours) * 60 * 60 * 1000
  timer = setInterval(() => { void checkAll({ reason: '定时' }) }, ms)
  log(`更新定时检查：每 ${hours} 小时一次`)
}

export function stop(): void {
  if (timer !== null) { clearInterval(timer); timer = null }
}
