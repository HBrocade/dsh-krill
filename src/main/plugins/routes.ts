/**
 * 插件声明的路线（`krill.routes`）落盘到 `~/.dsh/settings.yaml`。
 *
 * 合并 / 移除的规则在 route-decls.ts（纯函数，有测试）；这里只管读 manifest、
 * 备份、写文件、记日志。装的时候在通道安装**之后**调 —— 通道装失败就不该
 * 留下半套配置；卸的时候和代码级补丁一起撤。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../backend/log-ring.ts'
import { settingsPath } from '../catalog/settings.ts'
import { readRouteDecls, mergeRouteDecls, removeRouteDecls, type RouteDecl } from './route-decls.ts'

export interface RouteOutcome {
  id: string
  ok: boolean
  detail: string
}

function declsOf(pluginDir: string): RouteDecl[] {
  try {
    return readRouteDecls(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')))
  } catch {
    return []
  }
}

/** 写之前备份。settings.yaml 里还有凭据引用与模型默认值，写坏了 dsh 起不来。 */
function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-routes-${String(Date.now())}`)
}

function report(out: readonly RouteOutcome[], onOutput?: (line: string) => void): void {
  for (const o of out) {
    log(`路线声明：${o.id} ${o.detail}`, o.ok ? 'app' : 'stderr')
    onOutput?.(`${o.ok ? '✓' : '✗'} 路线 ${o.id}：${o.detail}`)
  }
}

/** 把插件声明的路线写进 settings.yaml；同名已存在的保留不动。没有声明时返回空。 */
export function apply(pluginDir: string, onOutput?: (line: string) => void): RouteOutcome[] {
  const decls = declsOf(pluginDir)
  if (decls.length === 0) return []
  const path = settingsPath()
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const r = mergeRouteDecls(before, decls)
  if (r.added.length > 0) {
    backup(path)
    writeFileSync(path, r.text, 'utf8')
  }
  const out: RouteOutcome[] = [
    ...r.added.map((id) => ({ id, ok: true, detail: '已写入 settings.yaml，重启后端后可选' })),
    ...r.kept.map((id) => ({ id, ok: true, detail: '同名路线已存在，保留原配置未覆盖' })),
  ]
  report(out, onOutput)
  return out
}

/** 只删插件自己声明过的 id。 */
export function revert(pluginDir: string, onOutput?: (line: string) => void): RouteOutcome[] {
  const decls = declsOf(pluginDir)
  if (decls.length === 0) return []
  const path = settingsPath()
  if (!existsSync(path)) {
    return decls.map((d) => ({ id: d.id, ok: true, detail: 'settings.yaml 不存在，跳过' }))
  }
  const r = removeRouteDecls(readFileSync(path, 'utf8'), decls.map((d) => d.id))
  if (r.removed.length > 0) {
    backup(path)
    writeFileSync(path, r.text, 'utf8')
  }
  const removed = new Set(r.removed)
  const out = decls.map((d) => ({
    id: d.id, ok: true,
    detail: removed.has(d.id) ? '已从 settings.yaml 移除' : '本来就不在，跳过',
  }))
  report(out, onOutput)
  return out
}
