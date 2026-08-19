/**
 * 源码仓库更新检测（`~/deepseek-harness/dsh-source`）。
 *
 * **只报告，不自动 rebase。** 旧版桌面端会在后台静默 `git pull --rebase`，
 * 而那个仓库里躺着未推上游的本地提交（vision / live2d 等）—— 静默变基
 * 一旦冲突或误操作就可能丢工作。这里把 rebase 变成面板上的显式按钮。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { log } from '../backend/log-ring.ts'
import { loadConfig } from '../config/store.ts'
import type { SourceRepoUpdate } from '@shared/ipc'

const run = promisify(execFile)

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: timeoutMs, encoding: 'utf8' })
  return stdout.trim()
}

export async function check(): Promise<SourceRepoUpdate> {
  const cfg = loadConfig()
  const path = cfg.sourceRepoPath
  const ref = cfg.sourceRepoRef

  const base: SourceRepoUpdate = {
    path, exists: false, branch: null, behind: 0, ahead: 0, dirty: false, error: null,
  }
  if (!existsSync(path)) {
    log(`源码仓库检查：路径不存在，跳过（${path}）`)
    return base
  }

  try {
    await git(path, ['rev-parse', '--is-inside-work-tree'], 5_000)
  } catch {
    return { ...base, error: `${path} 存在但不是 git 仓库` }
  }

  // rebase/merge 中断时 HEAD 是游离的，落后/领先都是无意义的 0 ——
  // 必须先识别出来，否则面板会显示成「没事」
  const rebasing = existsSync(join(path, '.git', 'rebase-merge'))
    || existsSync(join(path, '.git', 'rebase-apply'))
  if (rebasing) {
    let progress = ''
    try {
      const n = readFileSync(join(path, '.git', 'rebase-merge', 'msgnum'), 'utf8').trim()
      const total = readFileSync(join(path, '.git', 'rebase-merge', 'end'), 'utf8').trim()
      progress = `（进度 ${n}/${total}）`
    } catch { /* rebase-apply 形式没有这两个文件 */ }
    const msg = `仓库停在一次未完成的 rebase 中${progress}。`
      + '落后/领先数字在游离 HEAD 上没有意义，已跳过比对。'
      + '请在仓库里 `git rebase --abort` 回到原状，或自行解决冲突后 `git rebase --continue`。'
    log(`源码仓库检查：${msg}`, 'stderr')
    return { ...base, exists: true, error: msg }
  }

  try {
    const branch = await git(path, ['branch', '--show-current'], 5_000)
    // fetch 可能很慢（网络），单独给宽限
    await git(path, ['fetch', '--quiet'], 120_000)
    const behind = Number(await git(path, ['rev-list', '--count', `HEAD..${ref}`], 15_000))
    const ahead = Number(await git(path, ['rev-list', '--count', `${ref}..HEAD`], 15_000))
    const status = await git(path, ['status', '--porcelain'], 15_000)
    const result: SourceRepoUpdate = {
      path, exists: true,
      branch: branch === '' ? null : branch,
      behind: Number.isFinite(behind) ? behind : 0,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      dirty: status !== '',
      error: null,
    }
    log(`源码仓库检查：分支 ${result.branch ?? '—'}，落后 ${result.behind}，领先 ${result.ahead}，`
      + `工作区${result.dirty ? '有改动' : '干净'}（对比 ${ref}）`)
    return result
  } catch (e) {
    return { ...base, exists: true, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 显式拉取（用户点按钮才会走到这）。
 *
 * 用 `--rebase --autostash`：把本地提交叠回上游最新之上，脏工作区自动收进 stash 再还原。
 * 冲突时 git 会中止并保留冲突状态 —— 这里**不代为解决**，原样把错误抛给面板，
 * 让用户自己去仓库里处理。代解冲突是丢代码最快的方式。
 */
export async function pull(): Promise<string> {
  const cfg = loadConfig()
  const path = cfg.sourceRepoPath
  if (!existsSync(path)) throw new Error(`仓库不存在：${path}`)

  if (existsSync(join(path, '.git', 'rebase-merge')) || existsSync(join(path, '.git', 'rebase-apply'))) {
    throw new Error('仓库里已有一次未完成的 rebase，先处理掉再拉取（`git rebase --abort` 或 `--continue`）')
  }

  const before = await git(path, ['rev-parse', '--short', 'HEAD'], 5_000)
  log(`拉取源码仓库 ${path}（rebase 到 ${cfg.sourceRepoRef}，--no-fork-point）`)
  try {
    await git(path, ['fetch', '--quiet'], 180_000)
    // **必须带 --no-fork-point**。fork-point 启发式靠上游 ref 的 reflog 推算分叉点，
    // 实测它会把本地未推上游的提交误判成「已在上游」而从重放列表里剔除 ——
    // 一旦被剔除的那个提交创建了某个目录，后续每个改动该目录的提交都会报
    // 「上游删了、你改了」的树级冲突，看起来像一堆冲突，其实是同一个误判的连锁反应。
    await git(path, ['rebase', '--autostash', '--no-fork-point', cfg.sourceRepoRef], 180_000)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 保留现场，让用户能自己看清冲突
    throw new Error(`rebase 失败，已保留仓库当前状态供你处理：\n${msg}\n\n`
      + '回到原状：在仓库里跑 `git rebase --abort`')
  }
  const after = await git(path, ['rev-parse', '--short', 'HEAD'], 5_000)
  const summary = before === after
    ? `已是最新（${after}）`
    : `${before} → ${after}`
  log(`源码仓库拉取完成：${summary}`)
  return summary
}
