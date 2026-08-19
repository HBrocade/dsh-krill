import { useEffect, useState } from 'react'
import type { UpdateReport, OpResult } from '@shared/ipc'

function ago(ts: number | null): string {
  if (ts === null) return '尚未检查'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚检查过'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前检查`
  return `${Math.floor(s / 3600)} 小时前检查`
}

export function UpdatesPanel(): React.JSX.Element {
  const [r, setR] = useState<UpdateReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    void window.dsh['update:state']().then(setR)
    return window.dsh.on('update:changed', setR)
  }, [])

  /** 统一跑一个可能失败的动作：置忙、收结果、把失败原文摊开给用户看。 */
  const act = async (key: string, fn: () => Promise<OpResult<unknown>>, okText: (v: unknown) => string): Promise<void> => {
    setBusy(key); setNote(null)
    const res = await fn()
    setBusy(null)
    setNote(res.ok
      ? { kind: 'ok', text: okText(res.value) }
      : { kind: 'err', text: res.error })
  }

  if (r === null) return <div className="panel"><div className="empty">加载中…</div></div>

  // 未推提交 or 脏工作区 = 高冲突风险，按钮要加一道确认
  const risky = r.sourceRepo.ahead > 0 || r.sourceRepo.dirty
  const upgradablePlugins = r.plugins.filter((p) => p.upgradable)
  const localOnes = r.plugins.filter((p) => p.source === 'local')
  const runtimeOnes = r.plugins.filter((p) => p.source === 'runtime')

  return (
    <div className="panel">
      <h1 className="panel-head">更新</h1>
      <p className="panel-sub">
        {ago(r.checkedAt)}
        {r.checking ? ' · 正在检查…' : ''}
      </p>

      <div className="toolbar">
        <button
          className="btn btn-primary"
          disabled={r.checking || busy !== null}
          onClick={() => { void act('check', () => window.dsh['update:check'](), () => '检查完成') }}
        >
          {r.checking ? '检查中…' : '立即检查'}
        </button>
        <span className="spacer" />
      </div>

      {note !== null ? (
        <div className={`note note-${note.kind}`}>{note.text}</div>
      ) : null}

      {/* ── dsh CLI ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">dsh 运行时</div>
            <div className="muted">
              当前 {r.cli.current ?? '未知'}
              {r.cli.latest !== null ? ` · 最新 ${r.cli.latest}` : ''}
            </div>
          </div>
          {r.cli.upgradable ? (
            <button
              className="btn btn-primary"
              // 「升级中」以主进程的状态为准，不是本地 busy —— 切一次 tab 组件就重挂载，
              // 本地状态清零、按钮变回可点，再点一次就是第二个 npm 往同一个目录写
              disabled={busy !== null || r.cli.upgrading}
              onClick={() => {
                void act('cli', () => window.dsh['update:upgradeCli'](),
                  (v) => `已升级到 ${String(v)}，重启后端后生效`)
              }}
            >
              {r.cli.upgrading || busy === 'cli' ? '升级中…' : `升级到 ${r.cli.latest}`}
            </button>
          ) : (
            <span className="tag">{r.cli.error !== null ? '检查失败' : '已是最新'}</span>
          )}
        </div>
        {r.cli.upgradeStep !== null ? (
          // npm 装几分钟一声不吭，没有这行就跟卡死一模一样
          <div className="muted hint mono-line">{r.cli.upgradeStep}</div>
        ) : null}
        {r.cli.error !== null ? <div className="err-line">{r.cli.error}</div> : null}
        {r.cli.upgradable ? (
          <div className="muted hint">
            新版本装到应用数据目录（App 内的资源目录签名后只读），启动时优先于出厂版本。
            升级后需要重启后端才会切过去。
          </div>
        ) : null}
      </div>

      {/* ── 插件 ────────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">插件</div>
            <div className="muted">
              共 {r.plugins.length} 个
              {upgradablePlugins.length > 0 ? ` · ${upgradablePlugins.length} 个可升级` : ' · 全部最新'}
            </div>
          </div>
        </div>
        {r.plugins.length === 0 ? (
          <div className="muted hint">未读到任何 profile 依赖。</div>
        ) : (
          <table className="tbl">
            <tbody>
              {r.plugins.map((p) => (
                <tr key={`${p.profile}/${p.name}`}>
                  <td className="mono">
                    {p.name}
                    {p.inBundles ? <span className="tag tag-dim" title="在 dsh.profile.bundles 层叠里">层叠</span> : null}
                  </td>
                  <td className="muted">{p.profile}</td>
                  <td className="mono">{p.current ?? '—'}</td>
                  <td>
                    {p.upgradable
                      ? <span className="tag tag-hot">→ {p.latest}</span>
                      : p.source === 'runtime'
                        ? <span className="muted" title="随 dsh 运行时自带，版本跟着 dsh 走">随 dsh</span>
                        : p.source === 'local'
                          ? <span className="tag" title={p.error ?? undefined}>本地来源</span>
                          : p.error !== null
                            ? <span className="tag" title={p.error}>查询失败</span>
                            : <span className="muted">最新</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {upgradablePlugins.length > 0 ? (
          <div className="muted hint">插件升级在「插件」面板里操作（P3 阶段）。</div>
        ) : null}
        {runtimeOnes.length > 0 ? (
          <div className="muted hint">
            其中 {runtimeOnes.length} 个（{[...new Set(runtimeOnes.map((p) => p.name))].join('、')}）随 dsh 运行时自带，
            不在 profile 依赖里 —— 版本跟着 dsh 走，升级 dsh 即可，无需也无法单独升级。
          </div>
        ) : null}
        {localOnes.length > 0 ? (
          <div className="muted hint">
            {localOnes.length} 个来自本地目录或 git，不在 registry 上，无法比对版本。
          </div>
        ) : null}
      </div>

      {/* ── 源码仓库 ────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">源码仓库</div>
            <div className="muted mono">{r.sourceRepo.path}</div>
          </div>
          {r.sourceRepo.exists && r.sourceRepo.behind > 0 && r.sourceRepo.error === null ? (
            <button
              className={`btn${risky ? ' btn-danger' : ''}`}
              disabled={busy !== null}
              onClick={() => {
                // 有未推提交或脏工作区时，rebase 冲突概率很高 —— 不该一点就走。
                // 这不是形式主义：实测过 4 个未推提交 + 脏工作区 rebase 到 111 个
                // 上游提交之上，直接停在冲突里。
                if (risky && !confirmed) { setConfirmed(true); return }
                setConfirmed(false)
                void act('repo', () => window.dsh['update:pullSourceRepo'](), (v) => `拉取完成：${String(v)}`)
              }}
            >
              {busy === 'repo' ? '拉取中…'
                : confirmed ? '确认拉取？再点一次'
                  : `拉取 ${r.sourceRepo.behind} 个提交`}
            </button>
          ) : null}
        </div>
        {!r.sourceRepo.exists ? (
          <div className="muted hint">目录不存在，跳过检查。</div>
        ) : (
          <>
            <div className="muted">
              分支 {r.sourceRepo.branch ?? '—'}
              {r.sourceRepo.behind > 0 ? ` · 落后 ${r.sourceRepo.behind}` : ' · 已是最新'}
              {r.sourceRepo.ahead > 0 ? ` · 本地领先 ${r.sourceRepo.ahead}` : ''}
              {r.sourceRepo.dirty ? ' · 工作区有改动' : ''}
            </div>
            {r.sourceRepo.ahead > 0 ? (
              <div className="muted hint">
                本地有 {r.sourceRepo.ahead} 个未推上游的提交。拉取会用 rebase 把它们叠到上游最新之上；
                <b>冲突时会中止并保留现场，不会代你解决</b> —— 需要你自己去仓库里处理。
              </div>
            ) : null}
          </>
        )}
        {r.sourceRepo.error !== null ? (
          <div className="err-line">
            {r.sourceRepo.error}
            {r.sourceRepo.error.includes('未完成的 rebase') ? (
              <div style={{ marginTop: 8 }}>
                <span className="mono">cd {r.sourceRepo.path} &amp;&amp; git rebase --abort</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── 桌面 App 自身 ───────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">Krill 本体</div>
            <div className="muted">当前 {r.app.current}</div>
          </div>
          {!r.app.configured ? (
            <span className="tag">未配置发布渠道</span>
          ) : r.app.status === 'available' ? (
            <button className="btn btn-primary" disabled={busy !== null}
              onClick={() => { void act('dl', () => window.dsh['update:appDownload'](), () => '开始下载') }}>
              下载 {r.app.latest}
            </button>
          ) : r.app.status === 'downloaded' ? (
            <button className="btn btn-primary" disabled={busy !== null}
              onClick={() => { void act('inst', () => window.dsh['update:appInstall'](), () => '即将重启') }}>
              安装并重启
            </button>
          ) : r.app.status === 'downloading' ? (
            <span className="tag tag-hot">下载中 {r.app.progressPercent ?? 0}%</span>
          ) : (
            <span className="muted">已是最新</span>
          )}
        </div>
        {!r.app.configured ? (
          <div className="muted hint">
            自更新需要一个发布渠道。在应用数据目录的 <span className="mono">config.json</span> 里
            填 <span className="mono">appUpdateFeedUrl</span> 即可启用；留空时这项保持静默，不会报错。
          </div>
        ) : null}
        {r.app.error !== null ? <div className="err-line">{r.app.error}</div> : null}
      </div>
    </div>
  )
}
