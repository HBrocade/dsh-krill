/**
 * 主区顶栏：拖窗口的把手 + 用量。
 *
 * 用量原来是会话页右侧的一列。官方 SPA 后来自己在右边加了面板（工作区文件、终端），
 * 两列挤在一起；而且 SPA 铺满了除左轨以外的整窗，能拖窗口的只剩左边那条轨道。
 * 挪到顶上做成横栏，两件事一起解决 —— 栏本身是 drag 区，只有按钮和带提示的字段
 * 单独 no-drag（drag 区里的元素收不到鼠标事件，title 提示也出不来）。
 *
 * 两类数字刻意分开呈现，因为可信度不同：
 *   · token 明细 —— 从会话日志投影，来自 provider 响应，**精确**
 *   · 余额与差值 —— 问 DeepSeek，**精确**
 * 不显示「本次会话花了多少钱」：那需要一张会过期的价目表（三模型 × 三类 token
 * × 峰谷两时段），给出的会是个看起来精确的错数字。
 *
 * 各模型明细是往下展开、把 SPA 顶下去，而不是做成浮层：SPA 是盖在外壳上面的
 * 另一个 WebContentsView，外壳里的浮层会被它整个挡住。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ModelUsage, OpResult, UsageReport } from '@shared/ipc'

const DELTA_NOTE = '与首次查看这个会话时的余额之差。账户是共用的 —— 同时跑的别的会话或工具也会算进来。'

/** 大数字压成 12.3K / 1.2M —— 65562 这种原样显示太占横向地方 */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function hitRate(m: ModelUsage): number {
  const total = m.inputTokens + m.cacheReadTokens
  return total === 0 ? 0 : Math.round((m.cacheReadTokens / total) * 100)
}

function ModelRow({ m }: { m: ModelUsage }): React.JSX.Element {
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
        <span>缓存命中</span><b>{short(m.cacheReadTokens)} <i>{hitRate(m)}%</i></b>
        {m.reasoningTokens > 0 ? <><span>思考</span><b>{short(m.reasoningTokens)}</b></> : null}
        <span>请求</span><b>{m.calls}</b>
      </div>
    </div>
  )
}

export function UsageBar(): React.JSX.Element {
  const [r, setR] = useState<UsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [showBalance, setShowBalance] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(() => localStorage.getItem('usagebar.open') === '1')

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

  const toggle = (): void => {
    setOpen((v) => {
      localStorage.setItem('usagebar.open', v ? '0' : '1')
      return !v
    })
  }

  // 余额是账户级的数，标明「DeepSeek」就不会和会话混淆，所以始终显示 ——
  // 新会话、别家路由的会话里照样能看、能刷新。
  // 会话那半边（token 合计、明细）仍只在走过 DeepSeek 官方路由时出现：会话用的是
  // MiniMax、opencode-go 这类别家路由时，把它的 token 摆在余额旁边，只会让人以为
  // 两者相关。「本会话期间」的差值同理，由主进程只给官方会话记账来保证。
  const rep = r !== null && r.usesOfficial ? r : null

  return (
    <header className={`topbar${rep !== null && open ? ' open' : ''}`}>
      <div className="topbar-row">
        {rep !== null ? <Summary rep={rep} open={open} onToggle={toggle} /> : null}
        <div className="spacer" />
        {r !== null ? (
          <Money
            rep={r} busy={busy} note={note}
            showBalance={showBalance} onFlip={() => { setShowBalance(!showBalance) }}
            onRefresh={refresh}
          />
        ) : null}
      </div>
      {rep !== null && open ? <Detail rep={rep} note={note} /> : null}
    </header>
  )
}

/** 左半：当前会话的 token 合计，和展开明细的开关。 */
function Summary(props: { rep: UsageReport; open: boolean; onToggle: () => void }): React.JSX.Element {
  const { rep, open, onToggle } = props
  const models = rep.current?.models ?? []
  const t = rep.current?.totals
  return (
    <>
      <div className="tb-session">
        <span className="tb-label">当前会话</span>
        {t === undefined || models.length === 0 ? (
          <span className="tb-label">还没有用量记录</span>
        ) : (
          <>
            <span className="tb-model">
              {models.length === 1 ? models[0]?.model : `${models.length} 个模型`}
            </span>
            <span className="tb-kv">输入<b>{short(t.inputTokens)}</b></span>
            <span className="tb-kv">输出<b>{short(t.outputTokens)}</b></span>
            <span className="tb-kv">命中<b>{hitRate(t)}%</b></span>
            <span className="tb-kv">请求<b>{t.calls}</b></span>
          </>
        )}
      </div>
      <button className="tb-toggle" onClick={onToggle} title={open ? '收起明细' : '按模型展开明细'}>
        明细
        <svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8l4 4 4-4" />
        </svg>
      </button>
    </>
  )
}

/** 右半：余额、会话期间的余额差、刷新。 */
function Money(props: {
  rep: UsageReport
  busy: boolean
  note: string | null
  showBalance: boolean
  onFlip: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const { rep, busy, note, showBalance, onFlip, onRefresh } = props
  const bal = rep.balance
  const err = note ?? rep.error
  return (
    <>
      {err !== null ? <span className="tb-err" title={err}>{err}</span> : null}
      {bal !== null && rep.billing !== null ? (
        <span className="tb-delta" title={DELTA_NOTE}>
          本会话期间
          <b>{rep.billing.spent >= 0 ? '−' : '+'}{Math.abs(rep.billing.spent).toFixed(2)}</b>
        </span>
      ) : null}
      {bal === null ? (
        <span className="tb-label">
          {rep.hasApiKey ? 'DeepSeek 余额未查询' : '未配置 DEEPSEEK_API_KEY'}
        </span>
      ) : (
        <button
          className="tb-balance" onClick={onFlip}
          title={`DeepSeek 官方账户余额，${showBalance ? '点击隐藏' : '点击显示'}`}
        >
          <span className="tb-label">DeepSeek 余额</span>
          <b>{showBalance ? `${bal.currency} ${bal.total.toFixed(2)}` : `${bal.currency} ••••`}</b>
          {!bal.available ? <span className="tb-bad">账户不可用</span> : null}
        </button>
      )}
      <button className="btn btn-sm" disabled={busy} onClick={onRefresh}>
        {busy ? '查询中…' : '刷新余额'}
      </button>
    </>
  )
}

/** 展开的明细：每个模型一张卡，加上几条口径说明。 */
function Detail({ rep, note }: { rep: UsageReport; note: string | null }): React.JSX.Element {
  const models = rep.current?.models ?? []
  const err = note ?? rep.error
  return (
    <div className="topbar-detail">
      {models.map((m) => (
        <div className="usage-card tb-card" key={`${m.provider}/${m.model}`}>
          <ModelRow m={m} />
        </div>
      ))}
      <div className="tb-notes">
        {rep.officialTotals !== null ? (
          <div className="tb-notes-lead">
            本次会话经官方路由：输出 {short(rep.officialTotals.outputTokens)}
            {' · '}{rep.officialTotals.calls} 次
          </div>
        ) : null}
        {rep.billing !== null ? <div>「本会话期间」是{DELTA_NOTE}</div> : null}
        <div>token 数来自模型响应，精确。DeepSeek 没有花费查询接口，金额只能靠余额差。</div>
        {err !== null ? <div className="err-line">{err}</div> : null}
      </div>
    </div>
  )
}
