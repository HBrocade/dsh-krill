/**
 * 插件检索 —— 插件面板右侧的一条轨道，和左边那条侧栏同一套行为：
 * 默认收成窄轨（只剩竖排标题），点一下展开成一列，选择记在本地。
 *
 * 是**一列**不是浮层：浮层展开时会盖住下面的清单，而这里的用法恰恰是
 * 「一边看检索结果、一边把包名填进安装框」，两边得同时看得见。
 *
 * 界面上刻意不给「一键安装」：这些包名是模型说的，**没有任何一个被核实过**。
 * 能做的是复制、或填进安装框 —— 让人自己按下那一步。
 */
import { useEffect, useState } from 'react'
import type { DiscoverHit, DiscoverRecord, DiscoverState } from '@shared/ipc'

const CONFIDENCE: Record<DiscoverHit['confidence'], { label: string; cls: string }> = {
  high: { label: '把握大', cls: 'tag-ok' },
  medium: { label: '不确定', cls: 'tag-dim' },
  low: { label: '可能是编的', cls: 'tag-bad' },
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一条存档的可复制全文 —— 复制出去是给人看的，不是给机器读的，所以走 markdown。 */
function asText(r: DiscoverRecord): string {
  const head = `# ${r.query}\n${stamp(r.ts)} · ${r.routeId} / ${r.model}\n`
  if (r.hits.length === 0) return `${head}\n${r.error ?? r.raw}`
  const body = r.hits.map((h) => {
    const lines = [`- ${h.name}（${CONFIDENCE[h.confidence].label}）：${h.summary}`]
    if (h.homepage !== null) lines.push(`  ${h.homepage}`)
    if (h.note !== null) lines.push(`  备注：${h.note}`)
    return lines.join('\n')
  }).join('\n')
  return `${head}\n${body}`
}

function matches(r: DiscoverRecord, needle: string): boolean {
  if (needle === '') return true
  const q = needle.toLowerCase()
  if (r.query.toLowerCase().includes(q) || r.model.toLowerCase().includes(q)) return true
  return r.hits.some((h) =>
    h.name.toLowerCase().includes(q)
    || h.summary.toLowerCase().includes(q)
    || (h.note ?? '').toLowerCase().includes(q))
}

export function DiscoverRail({ onUse }: { onUse: (spec: string) => void }): React.JSX.Element {
  // 默认收成轨道，选择记在本地 —— 与左侧栏用同一套约定
  const [rail, setRail] = useState(() => localStorage.getItem('discover.rail') !== '0')
  const [s, setS] = useState<DiscoverState | null>(null)
  // 路线与模型也记在本地：切一次面板组件就重挂载，不记的话每次回来都跳回默认，
  // 而这两项恰恰是「设一次就不想再设」的东西
  const [routeId, setRouteId] = useState(() => localStorage.getItem('discover.routeId') ?? '')
  const [model, setModel] = useState(() => localStorage.getItem('discover.model') ?? '')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const toggle = (): void => {
    setRail((v) => {
      localStorage.setItem('discover.rail', v ? '0' : '1')
      return !v
    })
  }

  const chooseRoute = (id: string): void => {
    setRouteId(id)
    localStorage.setItem('discover.routeId', id)
  }
  const chooseModel = (m: string): void => {
    setModel(m)
    localStorage.setItem('discover.model', m)
  }

  useEffect(() => {
    void window.dsh['discover:state']().then(setS)
    return window.dsh.on('discover:changed', setS)
  }, [])

  /**
   * 校准存下来的那对选择。
   *
   * 存档里的路线可能已经从 settings.yaml 里删了、模型可能已经不在这条路线上 ——
   * 那时落到「第一条配了 key 的」，并且**把落到的那条也记下来**，
   * 免得每次进来都重算一遍同一个兜底。
   */
  useEffect(() => {
    if (s === null) return
    const pick = s.routes.find((r) => r.id === routeId) ?? s.routes.find((r) => r.hasKey) ?? s.routes[0]
    if (pick === undefined) return
    if (pick.id !== routeId) chooseRoute(pick.id)
    if (!pick.models.includes(model)) chooseModel(pick.models[0] ?? '')
  }, [s, routeId, model])

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => { setNote({ kind: 'ok', text: `${what}已复制` }) },
      () => { setNote({ kind: 'err', text: '复制失败' }) },
    )
  }

  const count = s?.records.length ?? 0

  if (rail) {
    return (
      <aside className="side-rail rail">
        <button className="side-rail-tab" onClick={toggle} title="展开插件检索">
          <IconSearch />
          <span className="side-rail-label">插件检索</span>
          {count > 0 ? <span className="tag tag-dim">{count}</span> : null}
        </button>
      </aside>
    )
  }

  const route = s?.routes.find((r) => r.id === routeId) ?? null
  const shown = (s?.records ?? []).filter((r) => matches(r, filter.trim()))

  return (
    <aside className="side-rail">
      <div className="side-rail-head">
        <div className="card-title" style={{ margin: 0 }}>插件检索</div>
        <button className="rail-toggle" style={{ width: 'auto', padding: '0 9px' }}
          onClick={toggle} title="收起">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 10h11M11 6l4 4-4 4" />
          </svg>
          <span>收起</span>
        </button>
      </div>

      <div className="side-rail-body">
        {s === null ? <div className="muted">加载中…</div> : (
          <>
            <textarea
              className="input dsc-q-input"
              rows={2}
              placeholder="要什么能力？例如：让模型能读本地 PDF"
              value={query}
              onChange={(ev) => { setQuery(ev.target.value) }}
            />
            <div className="dsc-row">
              <select className="input select" value={routeId}
                onChange={(ev) => { chooseRoute(ev.target.value) }}>
                {s.routes.length === 0 ? <option value="">没有可用路线</option> : null}
                {s.routes.map((r) => (
                  <option key={r.id} value={r.id}>{r.displayName}{r.hasKey ? '' : '（未配 key）'}</option>
                ))}
              </select>
              <select className="input select" value={model}
                onChange={(ev) => { chooseModel(ev.target.value) }}>
                {(route?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button className="btn btn-primary"
                disabled={busy !== null || query.trim() === '' || routeId === '' || model === ''}
                onClick={() => {
                  setBusy('search'); setNote(null)
                  void window.dsh['discover:search']({ routeId, model, query: query.trim() }).then((res) => {
                    setBusy(null)
                    if (!res.ok) { setNote({ kind: 'err', text: res.error }); return }
                    setNote(res.value.error !== null
                      ? { kind: 'err', text: res.value.error }
                      : { kind: 'ok', text: `拿到 ${String(res.value.hits.length)} 条候选，已存本地` })
                  })
                }}>{busy === 'search' ? '检索中…' : '检索'}</button>
            </div>
            <div className="muted hint" style={{ marginTop: 6 }}>
              结果是<b>模型说的</b>，包名没有被核实过 —— 复制或填进安装框后自己确认再装。
              {route !== null && !route.hasKey ? ' 这条路线没配 key，会匿名发出去。' : ''}
            </div>

            {note !== null ? (
              <div className={`note note-${note.kind}`} style={{ margin: '10px 0 0' }}>{note.text}</div>
            ) : null}

            <div className="dsc-sep" />

            <div className="dsc-row">
              <input
                className="input"
                placeholder={`搜索本地已存的 ${String(count)} 条`}
                value={filter}
                onChange={(ev) => { setFilter(ev.target.value) }}
              />
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => {
                setBusy('reload'); setNote(null)
                void window.dsh['discover:reload']().then((res) => {
                  setBusy(null)
                  setNote(res.ok
                    ? { kind: 'ok', text: `已重读存档，共 ${String(res.value.records.length)} 条` }
                    : { kind: 'err', text: res.error })
                })
              }}>{busy === 'reload' ? '读取中…' : '刷新'}</button>
              <button className="btn btn-sm" title={s.storePath} onClick={() => {
                void window.dsh['discover:openStore']()
              }}>存档</button>
            </div>

            <div className="dsc-list">
              {shown.length === 0 ? (
                <div className="muted" style={{ padding: '14px 0' }}>
                  {count === 0 ? '还没有检索过。' : '没有匹配的存档。'}
                </div>
              ) : shown.map((r) => (
                <div className="dsc-rec" key={r.id}>
                  <div className="row">
                    <div>
                      <div className="dsc-q">{r.query}</div>
                      <div className="muted">
                        {stamp(r.ts)} · {r.routeId} / {r.model} · {String(r.hits.length)} 条候选
                      </div>
                    </div>
                    <div className="acts">
                      <button className="btn btn-sm" onClick={() => { copy(asText(r), '这条检索') }}>复制</button>
                      <button className="btn btn-sm btn-danger" onClick={() => {
                        void window.dsh['discover:remove']({ id: r.id })
                      }}>删除</button>
                    </div>
                  </div>

                  {r.error !== null ? <div className="err-line">{r.error}</div> : null}

                  {r.hits.map((h, i) => (
                    // 模型偶尔会把同一个包列两遍，名字当 key 会撞
                    <div className="dsc-hit" key={`${h.name}-${String(i)}`}>
                      <div className="row">
                        <div>
                          <span className="mono">{h.name}</span>
                          <span className={`tag ${CONFIDENCE[h.confidence].cls}`}>
                            {CONFIDENCE[h.confidence].label}
                          </span>
                        </div>
                        <div className="acts">
                          <button className="btn btn-sm" onClick={() => { copy(h.install ?? h.name, '包名') }}>复制</button>
                          <button className="btn btn-sm" title="填进安装框，装不装还是你按"
                            onClick={() => { onUse(h.install ?? h.name); setNote({ kind: 'ok', text: '已填进安装框' }) }}>
                            填入
                          </button>
                        </div>
                      </div>
                      {h.summary === '' ? null : <div className="muted desc">{h.summary}</div>}
                      {h.note === null ? null : <div className="muted desc">备注：{h.note}</div>}
                      {h.homepage === null ? null : (
                        <a className="dsc-link muted desc" href={h.homepage} onClick={(ev) => {
                          ev.preventDefault()
                          void window.dsh['app:openExternal'](h.homepage ?? '')
                        }}>{h.homepage}</a>
                      )}
                    </div>
                  ))}

                  {r.raw === '' ? null : (
                    <details className="patches">
                      <summary className="muted">模型原文</summary>
                      <pre className="dsc-raw">{r.raw}</pre>
                      <button className="btn btn-sm" onClick={() => { copy(r.raw, '原文') }}>复制原文</button>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function IconSearch(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="5" />
      <path d="M13 13l4 4" />
    </svg>
  )
}
