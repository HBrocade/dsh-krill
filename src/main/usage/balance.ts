/**
 * 查 DeepSeek 账户余额。
 *
 * DeepSeek 的 API 只有一个和钱有关的端点 —— `GET /user/balance`（官方文档导航里
 * 一共六个端点，没有任何用量/账单查询接口）。所以：
 *
 *   · 余额：精确，直接问
 *   · 花费：**没有接口**。两次余额相减就是这段时间的真实花费 —— 不依赖任何
 *     价目表，自动包含峰谷价与未来任何调价。DeepSeek 有峰谷价（北京时间
 *     9-12、14-18 为高峰，低谷五折），三个模型 × 三类 token × 两个时段
 *     = 十八个数要跟，还得跟住它调价 —— 那种估算迟早会在我们不知情时变错。
 *
 * key 直接读 dsh 自己的凭据文件，不另外存一份：多一处副本就多一处泄漏面，
 * 而且用户轮换 key 时我们这份会悄悄过期。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { log } from '../backend/log-ring.ts'
import type { BalanceInfo } from '@shared/ipc'

/**
 * 从 `~/.dsh/.credentials.yaml` 里取 DeepSeek 的 key。
 *
 * 这个文件有两种布局，0.1.1 起是后者，降级回旧版会读不懂（踩过）：
 *   旧：`KEY: value` 扁平
 *   新：`version: 1` + `refs:` 嵌套
 * 两种都认，免得跟着 dsh 版本来回改。
 */
function readApiKey(): string | null {
  let text: string
  try {
    text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  } catch {
    return null
  }
  // 不引 YAML 解析器：这里只要一个键，而把整份凭据读进对象反而扩大了暴露面
  for (const line of text.split('\n')) {
    const m = /^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    const raw = m[1] ?? ''
    const value = raw.replace(/^['"]|['"]$/g, '')
    return value === '' ? null : value
  }
  return null
}

export function hasApiKey(): boolean { return readApiKey() !== null }

/**
 * 查一次余额。
 *
 * @throws 没有 key、网络失败、或 DeepSeek 返回非 200 时抛，错误信息里**不含 key**。
 */
export async function fetchBalance(): Promise<BalanceInfo> {
  const key = readApiKey()
  if (key === null) {
    throw new Error('~/.dsh/.credentials.yaml 里没有 DEEPSEEK_API_KEY —— 先在 dsh 里配置 DeepSeek 凭据')
  }
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    // 只报状态码：响应体可能回显请求信息
    throw new Error(`DeepSeek 返回 HTTP ${String(res.status)}`)
  }
  const body = (await res.json()) as {
    is_available?: boolean
    balance_infos?: Array<{
      currency?: string
      total_balance?: string
      granted_balance?: string
      topped_up_balance?: string
    }>
  }
  const first = body.balance_infos?.[0]
  if (first === undefined) throw new Error('DeepSeek 没有返回余额信息')

  const info: BalanceInfo = {
    available: body.is_available ?? false,
    currency: first.currency ?? 'CNY',
    total: Number(first.total_balance ?? '0'),
    granted: Number(first.granted_balance ?? '0'),
    toppedUp: Number(first.topped_up_balance ?? '0'),
    at: Date.now(),
  }
  log(`余额查询：${info.currency} ${info.total.toFixed(2)}`)
  return info
}
