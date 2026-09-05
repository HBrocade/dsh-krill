/**
 * 供应商面板 —— 让可选模型列表跟上供应商线上实际提供的模型。
 *
 * 存在的理由：opencode 新出的模型在模型选择器里根本挑不到，而界面上完全看不出
 * 为什么 —— dsh 的「拉取可用模型」对内置目录里的供应商压根不发网络请求，
 * 点了也还是那几个。
 *
 * 用穿梭框而不是勾选列表：右侧代表的是**这条路线最终要有哪些补充模型**，
 * 所以它一开始就等于配置里现在的样子（已经补进去的都在右边），加和减是同一个动作。
 * 勾选列表表达不了这件事 —— 勾选框天然读作「这次要加什么」，取消勾选一个
 * 已经在用的模型看着像「不加」，实际却是「删掉」。
 *
 * 除 id 外每一项都是推来的，协议尤其 —— 拿 pi-ai 对了一遍，19 个里对 15 个。
 * 推错协议的模型不是少个功能，是每次请求都报错。所以逐个可挪、来源标在行上。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CatalogApi, CatalogCandidate, CatalogReport, CatalogRoute, OpResult,
} from '@shared/ipc'

const API_TAG: Record<CatalogApi, string> = {
  'anthropic-messages': 'Anthropic',
  'openai-completions': 'Chat',
  'openai-responses': 'Responses',
}

/**
 * 穿梭框里的一行。
 *
 * `detail` 只有本次查出来的候选才有 —— 目录自带的和已经补进配置的都是既成事实，
 * 完整元数据分别在 pi-ai 和 `settings.yaml` 里，不再解析一遍。
 */
interface XferItem {
  id: string
  name: string
  api: CatalogApi
  /** catalog = 目录自带；declared = 已补进配置；candidate = 线上有、还没补 */
  kind: 'catalog' | 'declared' | 'candidate'
  detail: CatalogCandidate | null
}

function fmtCtx(n: number): string {
  return n >= 1000 ? `${String(Math.round(n / 1000))}K` : String(n)
}

function ago(ts: number | null): string {
  if (ts === null) return '尚未检查'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚检查过'
  if (s < 3600) return `${String(Math.floor(s / 60))} 分钟前检查`
  return `${String(Math.floor(s / 3600))} 小时前检查`
}

export function ProvidersPanel(): React.JSX.Element {
  const [r, setR] = useState<CatalogReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 每条路线右侧的模型 id。缺省 = 还没动过，等于配置里现在的样子。 */
  const [picked, setPicked] = useState<Record<string, string[] | undefined>>({})
  /** 每条路线的过滤词。二三十行的时候找一个特定型号比翻页快。 */
  const [filter, setFilter] = useState<Record<string, string | undefined>>({})
  /**
   * 展开着的路线。默认全收起 —— 一条 opencode-go 就有二三十个候选，
   * 全摊开的话页面得滚半天才看得到第二个供应商。
   * 记在 localStorage：折叠状态是「我关心哪几条」，切走再回来不该忘。
   */
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('catalog.open') ?? '[]')
      return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
    } catch { return new Set() }
  })
  const toggleOpen = useCallback((id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      try { localStorage.setItem('catalog.open', JSON.stringify([...next])) } catch { /* 隐私模式下写不了，收起状态不记就是了 */ }
      return next
    })
  }, [])

  useEffect(() => {
    // 首次打开这个面板自动查一次：这是个专门为「列表落后了没有」而存在的面板，
    // 每次进来先看到一句「还没查过」等于让人再点一次才肯干活。
    // 只在本次运行没查过时触发 —— 报告住在主进程，切走再切回来不会重查。
    void window.dsh['catalog:state']().then((first) => {
      setR(first)
      if (first.checkedAt === null && !first.checking) void window.dsh['catalog:refresh']({ force: false })
    })
    return window.dsh.on('catalog:changed', setR)
  }, [])

  const act = useCallback(async (
    key: string,
    fn: () => Promise<OpResult<unknown>>,
    okText: (v: unknown) => string,
  ): Promise<void> => {
    setBusy(key); setNote(null)
    const res = await fn()
    setBusy(null)
    setNote(res.ok ? { kind: 'ok', text: okText(res.value) } : { kind: 'err', text: res.error })
  }, [])

  const keyed = useMemo(() => (r?.routes ?? []).filter((x) => x.hasKey), [r])
  const unkeyed = useMemo(() => (r?.routes ?? []).filter((x) => !x.hasKey), [r])

  if (r === null) return <div className="panel"><div className="empty">加载中…</div></div>

  /** 这条路线上所有可挪的行：目录自带的在前，已补的次之，本次查出来的候选在后。 */
  const itemsOf = (route: CatalogRoute): XferItem[] => [
    ...route.catalog.map((m): XferItem => ({ ...m, kind: 'catalog', detail: null })),
    ...route.declared.map((d): XferItem => ({ ...d, kind: 'declared', detail: null })),
    ...route.candidates.map((c): XferItem => ({
      id: c.id, name: c.name, api: c.api, kind: 'candidate', detail: c,
    })),
  ]

  /** 配置现在的样子：目录里在服务的 + 已经补进去的。 */
  const currentOf = (route: CatalogRoute): string[] =>
    [...route.catalogKept, ...route.declared.map((d) => d.id)]

  const rightIdsOf = (route: CatalogRoute): string[] => picked[route.id] ?? currentOf(route)

  const move = (route: CatalogRoute, ids: readonly string[], toRight: boolean): void => {
    const cur = new Set(rightIdsOf(route))
    for (const id of ids) {
      if (toRight) cur.add(id); else cur.delete(id)
    }
    setPicked((p) => ({ ...p, [route.id]: [...cur] }))
  }

  return (
    <div className="panel">
      <h1 className="panel-head">供应商</h1>
      <p className="panel-sub">
        {ago(r.checkedAt)}
        {r.checking ? ' · 正在检查…' : ''}
      </p>

      <div className="toolbar">
        <button
          className="btn btn-primary"
          disabled={r.checking || busy !== null}
          onClick={() => { void act('check', () => window.dsh['catalog:refresh']({ force: false }), () => '检查完成') }}
        >
          {r.checking ? '检查中…' : '检查供应商'}
        </button>
        <span className="spacer" />
      </div>

      {note !== null ? <div className={`note note-${note.kind}`}>{note.text}</div> : null}
      {r.error !== null ? <div className="note note-err">{r.error}</div> : null}

      <div className="card">
        <div className="card-title">为什么列表会落后</div>
        <div className="muted desc">
          可选模型列表来自 pi-ai 里一份<b>静态生成的快照</b>
          {r.piAiVersion === null ? null : <>（已装 <code>{r.piAiVersion}</code>）</>}
          ，而 dsh 对目录内的供应商<b>不发网络请求</b> ——
          所以供应商新上的模型，在选择器里怎么刷都刷不出来。这里直接问供应商要清单，
          只问<b>配了 key 的</b>那几条路线。
        </div>
      </div>

      {keyed.map((route) => {
        const items = itemsOf(route)
        const right = new Set(rightIdsOf(route))
        const q = (filter[route.id] ?? '').trim().toLowerCase()
        const match = (it: XferItem): boolean =>
          q === '' || it.id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
        const leftList = items.filter((it) => !right.has(it.id) && match(it))
        const rightList = items.filter((it) => right.has(it.id) && match(it))
        // 「有没有改动」按集合比，不按数量 —— 数量相等但换掉了一个模型同样得能写
        const dirty = [...right].sort().join(' ') !== currentOf(route).sort().join(' ')
        const dropped = route.catalog.length - route.catalogKept.length
        // 去掉目录里的模型必须写 models 清单，而 modelOverrides 与它互斥
        const blocked = route.hasModelOverrides
          && route.catalog.some((m) => !right.has(m.id))

        return (
          <div key={route.id} className="card">
            {/* 收起时摘要要说全「有没有要补的」，否则得逐个展开才知道该看哪条 */}
            <button
              className={`cat-head${open.has(route.id) ? ' open' : ''}`}
              onClick={() => { toggleOpen(route.id) }}
              aria-expanded={open.has(route.id)}
            >
              <span className="cat-chevron" aria-hidden>
                <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 5l5 5-5 5" />
                </svg>
              </span>
              <span className="mono">{route.id}</span>
              {route.declared.length > 0 ? <span className="tag tag-ok">已补 {route.declared.length}</span> : null}
              {dropped > 0 ? <span className="tag tag-dim">已去掉 {dropped}</span> : null}
              {route.candidates.length > 0 ? <span className="tag tag-hot">可补 {route.candidates.length}</span> : null}
              <span className="spacer" />
              <span className="muted">
                {!route.inCatalog
                  ? (route.error === null
                    ? <>自定义 · 已声明 {route.installedCount}{' · 线上 '}{route.liveCount}</>
                    : '自定义 · 未查成')
                  : route.error === null
                    ? <>目录 {route.installedCount}
                      {dropped > 0 ? `（在用 ${String(route.catalogKept.length)}）` : ''}
                      {' · 线上 '}{route.liveCount}
                      {route.liveCount - route.installedCount > 0
                        ? ` · 落后 ${String(route.liveCount - route.installedCount)}`
                        : ''}</>
                    : '未查成'}
              </span>
            </button>

            {!open.has(route.id) ? null : (
              <>
                {!route.inCatalog ? (
                  <div className="muted hint">
                    不在 pi-ai 内置目录里 —— 这是你自己声明的路线，「已声明」就是它
                    <code>models:</code> 里手写的那些。线上多出来的按协议落地：和这条路线
                    <b>同协议</b>的直接加进它的 <code>models:</code>，其余各开一条
                    「<code>{route.id}--ext-…</code>」路线，key 与请求头原样带过去。
                    协议是<b>推断</b>的（看每行的标签），推错了就是发一次请求报一次错，勾之前看一眼。
                  </div>
                ) : null}

                {route.error !== null
                  ? <div className="muted hint">{route.error}</div>
                  : null}

                {route.error === null && items.length === 0 ? (
                  <div className="muted hint">目录已经跟上线上，没有要补的。</div>
                ) : null}

                {route.error === null && items.length > 0 ? (
                  <>
                    <input
                      className="input xfer-filter"
                      type="search"
                      placeholder="过滤型号…"
                      value={filter[route.id] ?? ''}
                      onChange={(e) => { setFilter((f) => ({ ...f, [route.id]: e.target.value })) }}
                    />

                    <div className="xfer">
                      <XferColumn
                        title="不用"
                        hint="不放进模型选择器"
                        items={leftList}
                        side="left"
                        disabled={busy !== null}
                        onMove={(id) => { move(route, [id], true) }}
                      />
                      <div className="xfer-mid">
                        <button
                          className="btn btn-sm"
                          disabled={busy !== null || leftList.length === 0}
                          title="把左边（过滤后）全部移到右边"
                          onClick={() => { move(route, leftList.map((i) => i.id), true) }}
                        >
                          全部 &rsaquo;
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy !== null || rightList.length === 0}
                          title="把右边（过滤后）全部移回左边"
                          onClick={() => { move(route, rightList.map((i) => i.id), false) }}
                        >
                          &lsaquo; 全部
                        </button>
                      </div>
                      <XferColumn
                        title="要用"
                        hint="出现在模型选择器里"
                        items={rightList}
                        side="right"
                        disabled={busy !== null}
                        onMove={(id) => { move(route, [id], false) }}
                      />
                    </div>

                    <div className="install-row">
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busy !== null || !dirty || blocked}
                        onClick={() => {
                          void act(
                            `apply:${route.id}`,
                            () => window.dsh['catalog:apply']({ routeId: route.id, modelIds: [...right] }),
                            (v) => `已写入 ${String(v)} 个模型，重启后端后出现在选择器里`,
                          )
                        }}
                      >
                        {dirty ? `写入配置（${String(right.size)}）` : '没有改动'}
                      </button>
                      {dirty ? (
                        <button
                          className="btn btn-sm"
                          disabled={busy !== null}
                          onClick={() => { setPicked((p) => ({ ...p, [route.id]: undefined })) }}
                        >
                          还原
                        </button>
                      ) : null}
                      {route.declared.length > 0 || dropped > 0 ? (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy !== null}
                          title="删掉补进去的目录外路线，并让目录恢复整份服务"
                          onClick={() => {
                            void act(
                              `clear:${route.id}`,
                              () => window.dsh['catalog:clear']({ routeId: route.id }),
                              (v) => `已撤回 ${String(v)} 个补充模型，目录恢复整份服务`,
                            )
                          }}
                        >
                          恢复默认
                        </button>
                      ) : null}
                    </div>

                    {blocked ? (
                      <div className="err-line">
                        这条路线写了 <code>modelOverrides</code>，它和 <code>models</code> 互斥 ——
                        而去掉目录里的模型只能靠写一份 <code>models</code> 保留清单。
                        先把 <code>modelOverrides</code> 挪成 <code>models</code> 条目上的字段，或者把目录模型都留着。
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        )
      })}

      {unkeyed.length > 0 ? (
        <div className="muted hint">
          跳过了 {unkeyed.map((x) => x.id).join('、')} —— 没找到对应的凭据
          {unkeyed.some((x) => x.apiKeyEnv !== null)
            ? <>（<code>{unkeyed.map((x) => x.apiKeyEnv).filter((v) => v !== null).join('、')}</code>）</>
            : null}
          。没配 key 的供应商，把模型补进去也选不了。
        </div>
      ) : null}

      {keyed.some((x) => x.inCatalog && x.error === null) ? (
        <div className="muted hint">
          两半分开落地，机制不一样：<b>目录外</b>补进来的按协议各单开一条「目录外」路线；
          而把<b>目录自带</b>的模型移到左边，只能在原路线上写一份<b>保留清单</b> ——
          dsh 没有黑名单，只有白名单。清单里光写 id，协议容量价格全从目录继承，不丢东西，
          但这条路线从此<b>不再跟随目录更新</b>（以后 pi-ai 补的新模型不会自己冒出来，
          会出现在左边等你挪）。把目录模型全留着时清单会被删掉，回到自动跟随。
          <br />
          协议是按 models.dev 记的 SDK 推的，<b>不保证与官方目录一致</b>；
          标着「元数据缺失」的连容量都是兜底值；标着「无思考档位」的会被当成不推理的模型 ——
          供应商没公布可选档位，而 dsh 只认「档位」这一种打开推理的写法。
        </div>
      ) : null}
    </div>
  )
}

/** 穿梭框的一侧。整行可点，点一下挪到对面。 */
function XferColumn(props: {
  title: string
  hint: string
  items: readonly XferItem[]
  side: 'left' | 'right'
  disabled: boolean
  onMove: (id: string) => void
}): React.JSX.Element {
  const { title, hint, items, side, disabled, onMove } = props
  return (
    <div className="xfer-col">
      <div className="xfer-head">
        <span>{title}</span>
        <span className="muted">{items.length}</span>
      </div>
      <div className="muted xfer-hint">{hint}</div>
      <div className="xfer-list">
        {items.length === 0 ? <div className="muted xfer-empty">（空）</div> : null}
        {items.map((it) => (
          <button
            key={it.id}
            className="xfer-item"
            disabled={disabled}
            title={`${it.name} —— 点一下移到${side === 'left' ? '右' : '左'}边`}
            onClick={() => { onMove(it.id) }}
          >
            {side === 'right' ? <span className="xfer-arrow" aria-hidden>&lsaquo;</span> : null}
            <span className="xfer-id mono">{it.id}</span>
            <span className="xfer-name muted">{it.name}</span>
            <span className="tag tag-dim">{API_TAG[it.api]}</span>
            {it.kind === 'catalog' ? (
              // 目录自带：完整元数据在 pi-ai 里，这里不复述
              <span className="tag tag-dim">目录自带</span>
            ) : it.kind === 'declared' ? (
              // 已经补进配置：当初推出来的细节留在 settings.yaml，这里不再解析一遍
              <span className="tag tag-ok">已补</span>
            ) : it.detail === null ? null : (
              <>
                <span className="muted xfer-cap">{fmtCtx(it.detail.contextWindow)}</span>
                {it.detail.input.includes('image') ? <span className="tag tag-dim">图</span> : null}
                {it.detail.reasoningEfforts !== null ? <span className="tag tag-dim">思考</span> : null}
                {it.detail.reasonsWithoutLevels ? <span className="tag tag-warn">无思考档位</span> : null}
                {!it.detail.described ? <span className="tag tag-warn">元数据缺失</span> : null}
                {/* 协议不是从目录抄来的就得说清楚是怎么推的：推错协议是发一次报一次错 */}
                {it.detail.apiSource === 'family' ? <span className="tag tag-warn">协议按名族推断</span> : null}
                {it.detail.apiSource === 'fallback' ? <span className="tag tag-warn">协议兜底</span> : null}
              </>
            )}
            {side === 'left' ? <span className="xfer-arrow" aria-hidden>&rsaquo;</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
