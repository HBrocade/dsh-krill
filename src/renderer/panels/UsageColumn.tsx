/**
 * 会话页右侧的用量栏。
 *
 * 两类数字刻意分开呈现，因为可信度不同：
 *   · token 明细 —— 从会话日志投影，来自 provider 响应，**精确**
 *   · 余额与差值 —— 问 DeepSeek，**精确**
 * 不显示「本次会话花了多少钱」：那需要一张会过期的价目表（三模型 × 三类 token
 * × 峰谷两时段），给出的会是个看起来精确的错数字。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ModelUsage, OpResult, UsageReport } from '@shared/ipc'

/** 大数字压成 12.3K / 1.2M —— 右栏窄，65562 这种原样显示会撑破 */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function ModelRow({ m }: { m: ModelUsage }): React.JSX.Element {
  const total = m.inputTokens + m.cacheReadTokens
  const hitRate = total === 0 ? 0 : Math.round((m.cacheReadTokens / total) * 100)
  return (
    <div className="usage-model">
      <div className="usage-model-name" title={`${m.provider}/${m.model}`}>
        {m.model}
        <i className={m.official ? 'usage-provider' : 'usage-provider usage-thirdparty'}>
          {m.provider}{m.official ? '' : ' · 不计入 DeepSeek 余额'}
        </i>
      </div>
      <div className="usage-grid">
        <span>输入</span><b>{short(m.inputTokens)}</b>
        <span>输出</span><b>{short(m.outputTokens)}</b>
        <span>缓存命中</span><b>{short(m.cacheReadTokens)} <i>{hitRate}%</i></b>
        {m.reasoningTokens > 0 ? <><span>思考</span><b>{short(m.reasoningTokens)}</b></> : null}
        <span>请求</span><b>{m.calls}</b>
      </div>
    </div>
  )
}

export function UsageColumn(): React.JSX.Element | null {
  const [r, setR] = useState<UsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [showBalance, setShowBalance] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.dsh['usage:state']().then(setR)
  }, [])

  useEffect(() => {
    load()
    // 主进程推：切换会话、当前会话有新消息落盘，都会立刻送一份过来
    const off = window.dsh.on('usage:changed', setR)
    // 兜底轮询留得很稀 —— 推送才是主路径，这条只防「监听失效了自己不知道」
    const t = setInterval(load, 60_000)
    return () => { off(); clearInterval(t) }
  }, [load])

  const refresh = (): void => {
    setBusy(true); setNote(null)
    void window.dsh['usage:refresh']().then((res: OpResult<UsageReport>) => {
      setBusy(false)
      if (res.ok) setR(res.value)
      else setNote(res.error)
    })
  }

  const cur = r?.current ?? null
  const bal = r?.balance ?? null

  // 整栏由「这个会话有没有走过 DeepSeek 官方路由」决定。
  //
  // 这是一块计费面板：会话用的是 MiniMax、opencode-go 这类别家路由时，它一个
  // 数字都说明不了 DeepSeek 账户的事，占着一列反而误导。收起来 SPA 也能宽一点 ——
  // 外壳的 ResizeObserver 盯的是落位区，这里返回 null 它就自然铺满。
  if (r === null || !r.usesOfficial) return null

  return (
    <aside className="usage-col">
      <div className="usage-head">
        <span>用量</span>
        <button className="btn btn-sm" disabled={busy} onClick={refresh}>
          {busy ? '查询中…' : '刷新余额'}
        </button>
      </div>

      <div className="usage-card">
        <div className="usage-card-title">
          账户余额
          <i className="usage-hint">DeepSeek 官方</i>
        </div>
        {bal === null ? (
          <div className="muted usage-empty">
            {r?.hasApiKey === false
              ? '未配置 DEEPSEEK_API_KEY'
              : '点「刷新余额」查询'}
          </div>
        ) : (
          <>
            <div className="usage-balance" onClick={() => { setShowBalance(!showBalance) }}>
              {showBalance
                ? `${bal.currency} ${bal.total.toFixed(2)}`
                : `${bal.currency} ••••`}
              <i className="usage-hint">{showBalance ? '点击隐藏' : '点击显示'}</i>
            </div>
            {r.billing !== null ? (
              <div className="usage-delta">
                本会话期间 {r.billing.spent >= 0 ? '−' : '+'}
                {Math.abs(r.billing.spent).toFixed(2)}
                <i>
                  与首次查看这个会话时的余额之差。账户是共用的 ——
                  同时跑的别的会话或工具也会算进来。
                </i>
              </div>
            ) : null}
            {!bal.available ? <div className="err-line">账户不可用</div> : null}
          </>
        )}
        {r.officialTotals !== null ? (
          <div className="usage-official">
            本次会话经官方路由：输出 {short(r.officialTotals.outputTokens)}
            · {r.officialTotals.calls} 次
          </div>
        ) : null}
      </div>

      <div className="usage-card">
        <div className="usage-card-title">
          当前会话
          {cur !== null ? <i className="usage-hint">{cur.totals.calls} 次请求</i> : null}
        </div>
        {cur === null || cur.models.length === 0 ? (
          <div className="muted usage-empty">还没有用量记录</div>
        ) : (
          cur.models.map((m) => <ModelRow key={`${m.provider}/${m.model}`} m={m} />)
        )}
      </div>

      {note !== null ? <div className="err-line usage-note">{note}</div> : null}
      {r?.error !== null && r?.error !== undefined ? (
        <div className="err-line usage-note">{r.error}</div>
      ) : null}

      <div className="muted usage-foot">
        token 数来自模型响应，精确。<br />
        DeepSeek 没有花费查询接口，金额只能靠余额差。
      </div>
    </aside>
  )
}
