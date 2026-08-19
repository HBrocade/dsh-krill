/**
 * dsh-super-injector 的 HTTP 客户端。
 *
 * 注入器把四条路由挂在 **dsh web 的同一个端口**上（前缀 `/super-injector/api`），
 * 所以桌面端直接 HTTP 调用即可热装卸，不必经 AI 对话去触发它的 `dev_*` 工具。
 *
 * 注入器是第三方插件（非官方保证），**必须允许它缺席**：
 * 探测失败一律降级为「热更新通道不可用」，而不是让整个插件面板报错。
 */
import { getStatus } from '../backend/supervisor.ts'

const PREFIX = '/super-injector/api'
const TIMEOUT_MS = 20_000

export interface InjectorEntry {
  /** loader entry 的完整包名 */
  name?: string
  id?: string
  /** fiber 是否活跃 */
  active?: boolean
  dir?: string
  [k: string]: unknown
}

export interface InjectorList {
  ok: boolean
  entries: InjectorEntry[]
  /** 该部署是否声明了 client 面（注入器读 DSH_WEB 环境变量得出） */
  clientDeclared: boolean
  stats?: unknown
}

function baseUrl(): string | null {
  return getStatus().url
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = baseUrl()
  if (base === null) throw new Error('后端未就绪，无法访问注入器')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${PREFIX}${path}`, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(res.status === 404
        ? '注入器未安装或未生效（路由 404）'
        : `注入器返回 HTTP ${res.status}：${text.slice(0, 300)}`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`注入器返回的不是 JSON：${text.slice(0, 200)}`)
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('注入器请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 注入器在不在。用于决定面板要不要给出热更新通道。 */
export async function probe(): Promise<boolean> {
  try {
    const r = await call<InjectorList>('/list')
    return r.ok === true
  } catch {
    return false
  }
}

export async function list(): Promise<InjectorList> {
  const r = await call<InjectorList>('/list')
  return {
    ok: r.ok === true,
    entries: Array.isArray(r.entries) ? r.entries : [],
    clientDeclared: r.clientDeclared === true,
    stats: r.stats,
  }
}

/** 运行时注入一个本地插件目录，免重启。 */
export async function inject(dir: string): Promise<string> {
  const r = await call<{ ok?: boolean; message?: string; error?: string }>('/inject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  if (r.ok === false) throw new Error(r.error ?? r.message ?? '注入失败（注入器未给出原因）')
  return r.message ?? '注入成功'
}

/**
 * 热卸载。
 *
 * **本项目刻意不用它** —— 实测热卸载会留残留（僵尸工具、webserver 孤儿路由、
 * profile patch 里永久累积的 disabled 条目）。卸载走「标记 + 重启」。
 * 这里保留封装只为诊断用途，正常路径不会调到。
 */
export async function uninstallHot(match: string): Promise<string> {
  const r = await call<{ ok?: boolean; message?: string; error?: string }>('/uninstall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ match }),
  })
  if (r.ok === false) throw new Error(r.error ?? r.message ?? '卸载失败')
  return r.message ?? '已卸载'
}
