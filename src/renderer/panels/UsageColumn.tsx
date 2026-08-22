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
      <div className="usage-model-name" title={m.model}>{m.model}</div>
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

export function UsageColumn(): React.JSX.Element {
  const [r, setR] = useState<UsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [showBalance, setShowBalance] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.dsh['usage:state']().then(setR)
  }, [])

  useEffect(() => {
    load()
    // 会话日志是随聊天不断追加的，隔一会儿重读一次。只读本地文件，不发网络请求
    const t = setInterval(load, 15_000)
    return () => { clearInterval(t) }
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

  return (
    <aside className="usage-col">
      <div className="usage-head">
        <span>用量</span>
        <button className="btn btn-sm" disabled={busy} onClick={refresh}>
          {busy ? '查询中…' : '刷新余额'}
        </button>
      </div>

      <div className="usage-card">
        <div className="usage-card-title">账户余额</div>
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
            {r?.balanceDelta !== null && r?.balanceDelta !== undefined ? (
              <div className="usage-delta">
                较上次 {r.balanceDelta >= 0 ? '+' : ''}{r.balanceDelta.toFixed(2)}
                <i>（两次查询之差 = 期间真实花费）</i>
              </div>
            ) : null}
            {!bal.available ? <div className="err-line">账户不可用</div> : null}
          </>
        )}
      </div>

      <div className="usage-card">
        <div className="usage-card-title">
          当前会话
          {cur !== null ? <i className="usage-hint">{cur.totals.calls} 次请求</i> : null}
        </div>
        {cur === null || cur.models.length === 0 ? (
          <div className="muted usage-empty">还没有用量记录</div>
        ) : (
          cur.models.map((m) => <ModelRow key={m.model} m={m} />)
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
