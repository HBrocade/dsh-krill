/**
 * 宿主机环境检测。
 *
 * Krill 自己是自包含的（Electron + 内嵌运行时），但有几件事要借外部命令：
 * 升级 dsh 要 npm、源码仓库检测要 git、mod 的代码级补丁要 patch。
 * 这些在开发者机器上理所当然，在一台干净的 Mac 上未必有 —— 而缺失的表现
 * 往往是「某个按钮点了没反应」，用户根本无从判断是缺环境还是有 bug。
 *
 * 所以把它变成一件明说的事：面板上列出每项的状态、缺的那项用来干什么、
 * 以及能不能由 Krill 代装。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { which } from '../backend/locate.ts'
import { toolchainNodeBin } from './install-node.ts'
import type { EnvReport, EnvTool } from '@shared/ipc'

/** 跑 `<cmd> --version` 取版本号；失败返回 null。 */
function versionOf(bin: string, args: string[] = ['--version']): string | null {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8_000 })
    if (r.status !== 0) return null
    const line = (r.stdout || r.stderr || '').split('\n')[0]?.trim() ?? ''
    return line === '' ? null : line
  } catch {
    return null
  }
}

/**
 * Xcode 命令行工具装没装。
 *
 * `/usr/bin/git` 在没装 CLT 的机器上也存在，但它只是个桩 —— 执行时会弹出
 * 系统的安装对话框而不是干活。所以不能靠 `existsSync` 判断，得问 xcode-select。
 */
function commandLineToolsInstalled(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return spawnSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 8_000 }).status === 0
  } catch {
    return false
  }
}

function checkNode(): EnvTool {
  // 自带的那份优先 —— 它是 Krill 装的，版本可控
  const bundled = toolchainNodeBin()
  const bin = bundled !== null && existsSync(bundled) ? bundled : which('node')
  const version = bin === null ? null : versionOf(bin)
  return {
    id: 'node',
    label: 'Node.js',
    purpose: '升级 dsh 运行时（npm 要它），也是跑后端时优先选用的解释器',
    path: bin,
    version,
    ok: version !== null,
    // 唯一一个 Krill 能代装的：官方 tarball 解到应用数据目录，不需要管理员权限
    fixable: version === null,
    hint: version === null
      ? '系统不自带 Node.js。可以让 Krill 代装一份到应用数据目录 —— 不需要管理员权限，'
        + '也不会动系统里已有的任何东西。'
      : bin === bundled ? '用的是 Krill 自己装的那份' : null,
  }
}

function checkNpm(): EnvTool {
  const bundled = toolchainNodeBin()
  const bundledNpm = bundled === null ? null : bundled.replace(/node$/, 'npm')
  const bin = bundledNpm !== null && existsSync(bundledNpm) ? bundledNpm : which('npm')
  const version = bin === null ? null : versionOf(bin)
  return {
    id: 'npm',
    label: 'npm',
    purpose: '升级 dsh 运行时',
    path: bin,
    version,
    ok: version !== null,
    // npm 跟着 Node 一起来，不单独装
    fixable: false,
    hint: version === null ? '跟 Node.js 一起安装，装上 Node 就有了。' : null,
  }
}

function checkGit(): EnvTool {
  const bin = which('git')
  const clt = commandLineToolsInstalled()
  // 没装 CLT 时 /usr/bin/git 只是个桩，问它版本会触发系统安装框，所以先看 CLT
  const version = bin !== null && clt ? versionOf(bin) : null
  return {
    id: 'git',
    label: 'git',
    purpose: '源码仓库的更新检测与拉取（不用这个功能就不需要它）',
    path: bin,
    version,
    ok: version !== null,
    fixable: false,
    hint: version === null
      ? process.platform === 'darwin'
        ? '终端里跑 `xcode-select --install` 装上 Xcode 命令行工具即可。'
          + '注意 /usr/bin/git 即使存在也可能只是个桩 —— 没装工具链时执行它会弹系统安装框。'
        : '用系统包管理器安装 git。'
      : null,
  }
}

function checkPatch(): EnvTool {
  const bin = which('patch')
  const version = bin === null ? null : versionOf(bin, ['-v'])
  return {
    id: 'patch',
    label: 'patch',
    purpose: 'mod 的代码级补丁（没装带补丁的 mod 就不需要它）',
    path: bin,
    version,
    ok: version !== null,
    fixable: false,
    hint: version === null ? 'macOS 与多数 Linux 自带；缺失说明系统环境不完整。' : null,
  }
}

export function inspect(): EnvReport {
  const tools = [checkNode(), checkNpm(), checkGit(), checkPatch()]
  return {
    platform: process.platform,
    arch: process.arch,
    tools,
    // 缺 node/npm 才真的挡路：升级按钮点了会失败。git / patch 只影响对应的单项功能
    blocking: tools.filter((t) => !t.ok && (t.id === 'node' || t.id === 'npm')).map((t) => t.id),
  }
}
