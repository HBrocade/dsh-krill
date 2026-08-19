/**
 * 从登录 shell 里问出用户真实的 PATH。
 *
 * 从 Finder / Dock 启动的 App 由 launchd 拉起，PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`。用户装在 `~/.local/bin`、homebrew、nvm、
 * volta 里的 node / npm 全都看不见 —— 而同一个 App 从终端启动却一切正常，
 * 因为那时继承的是 shell 的环境。
 *
 * 这个差异极难自查：用户看到的只是「更新按钮点下去报 spawn npm ENOENT」，
 * 而开发者在终端里怎么试都复现不了。
 *
 * 只在真的找不到命令时才问一次 —— 登录 shell 要跑完整套 rc 脚本
 * （nvm / gvm / conda 之类能拖到几百毫秒），没必要在启动路径上白花这个钱。
 */
import { spawnSync } from 'node:child_process'
import { log } from './log-ring.ts'

/** 用哨兵包住，避免把 rc 脚本打的招呼语当成路径 */
const OPEN = '__KRILL_PATH_BEGIN__'
const CLOSE = '__KRILL_PATH_END__'

let done = false

/**
 * 把登录 shell 的 PATH 并进 `process.env.PATH`。
 *
 * 幂等，且只真正执行一次。失败不抛 —— 补不上就维持现状，
 * 让调用方按「命令找不到」正常报错，那个错更有信息量。
 */
export function hydratePath(): void {
  if (done) return
  done = true
  if (process.platform === 'win32') return

  const shell = process.env.SHELL ?? '/bin/zsh'
  const r = spawnSync(shell, ['-ilc', `printf '${OPEN}%s${CLOSE}' "$PATH"`], {
    encoding: 'utf8',
    timeout: 8_000,
  })
  const out = r.stdout ?? ''
  const from = out.indexOf(OPEN)
  const to = out.indexOf(CLOSE)
  if (from < 0 || to <= from) {
    log(`没能从 ${shell} 问出 PATH，维持当前环境`, 'stderr')
    return
  }

  const discovered = out.slice(from + OPEN.length, to).split(':').filter((p) => p !== '')
  const current = (process.env.PATH ?? '').split(':').filter((p) => p !== '')
  const added = discovered.filter((p) => !current.includes(p))
  if (added.length === 0) return

  process.env.PATH = [...current, ...added].join(':')
  log(`PATH 从登录 shell 补全了 ${String(added.length)} 项（launchd 只给了 ${String(current.length)} 项）`)
}
