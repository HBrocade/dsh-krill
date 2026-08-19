/**
 * 源码仓库更新检测（`~/deepseek-harness/dsh-source`）。
 *
 * **只报告，不自动 rebase。** 旧版桌面端会在后台静默 `git pull --rebase`，
 * 而那个仓库里躺着未推上游的本地提交（vision / live2d 等）—— 静默变基
 * 一旦冲突或误操作就可能丢工作。这里把 rebase 变成面板上的显式按钮。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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

  const before = await git(path, ['rev-parse', '--short', 'HEAD'], 5_000)
  log(`拉取源码仓库 ${path}（rebase 到 ${cfg.sourceRepoRef}）`)
  try {
    await git(path, ['pull', '--rebase', '--autostash'], 180_000)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 保留现场，让用户能自己看清冲突
    throw new Error(`rebase 失败，已保留仓库当前状态供你处理：\n${msg}`)
  }
  const after = await git(path, ['rev-parse', '--short', 'HEAD'], 5_000)
  const summary = before === after
    ? `已是最新（${after}）`
    : `${before} → ${after}`
  log(`源码仓库拉取完成：${summary}`)
  return summary
}
