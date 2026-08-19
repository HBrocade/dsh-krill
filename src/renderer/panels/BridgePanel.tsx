import { useEffect, useState } from 'react'
import type { BridgeStatus, BridgeConfig, OpResult } from '@shared/ipc'

/**
 * 桥接面板：只有一个开关 + 一条可复制的接入命令。
 *
 * 端口、超时、并发、目录范围都是固定值，不给旋钮 —— 这个接口的定位就是
 * 「直接用 app 正在用的那套」。token 自动生成、自动嵌进命令，用户不用管。
 */
export function BridgePanel(): React.JSX.Element {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [cfg, setCfg] = useState<BridgeConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [reveal, setReveal] = useState(false)

  useEffect(() => {
    void window.dsh['bridge:status']().then(setSt)
    void window.dsh['bridge:config']().then(setCfg)
    return window.dsh.on('bridge:changed', setSt)
  }, [])

  const toggle = async (): Promise<void> => {
    if (cfg === null || st === null) return
    setBusy(true); setNote(null)
    const res: OpResult<BridgeConfig> = await window.dsh['bridge:setConfig']({ enabled: !st.running })
    setBusy(false)
    if (res.ok) {
      setCfg(res.value)
      void window.dsh['bridge:status']().then(setSt)
    } else {
      setNote({ kind: 'err', text: res.error })
    }
  }

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => setNote({ kind: 'ok', text: '接入命令已复制（含 token）' }),
      () => setNote({ kind: 'err', text: '复制失败' }),
    )
  }

  if (st === null || cfg === null) return <div className="panel"><div className="empty">加载中…</div></div>

  return (
    <div className="panel">
      <h1 className="panel-head">桥接接口</h1>
      <p className="panel-sub">
        让 Claude Code 等外部工具把 dsh 当作第二意见来源 —— 另一个模型、另一个角度看同一份改动
      </p>

      {note !== null ? <div className={`note note-${note.kind}`}>{note.text}</div> : null}

      {/* ── 开关 ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">服务状态</div>
            <div className="muted">
              {st.running ? `运行中 · 127.0.0.1:${String(st.port)}` : '未启动'}
              {st.running && st.totalServed > 0 ? ` · 已服务 ${String(st.totalServed)} 次` : ''}
              {st.inflight > 0 ? ` · 进行中 ${String(st.inflight)}` : ''}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              使用模型 <span className="mono">{st.model}</span>
            </div>
          </div>
          {/* 按钮反映**真实运行状态**而不是配置意图 —— 两者会分叉
              （比如开发开关强制启用时配置仍是关闭），这时照配置显示会自相矛盾 */}
          <button className={`btn${st.running ? '' : ' btn-primary'}`} disabled={busy} onClick={() => { void toggle() }}>
            {busy ? '处理中…' : st.running ? '关闭接口' : '启用接口'}
          </button>
        </div>
        <div className="muted hint">
          零配置：端口由系统分配，模型与凭据取自 <span className="mono">~/.dsh</span> 全局配置
          （和你聊天用的同一份），token 自动生成并嵌进下面的接入命令。
          <br />
          <b>默认关闭</b>。启用后只绑 <span className="mono">127.0.0.1</span>、强制 Bearer token、
          单任务超时 {Math.round(st.limits.timeoutMs / 1000)} 秒、并发上限 {st.limits.maxConcurrent}。
        </div>
        {st.lastError !== null ? <div className="err-line">{st.lastError}</div> : null}
      </div>

      {/* ── 接入 ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">接入 Claude Code</div>
        {!st.running ? (
          <div className="muted hint">启用接口后这里会给出可直接复制的接入命令。</div>
        ) : (
          <>
            <pre className="code-block">
              {reveal ? st.mcpCommand : st.mcpCommand.replace(st.token, '•'.repeat(24))}
            </pre>
            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <button className="btn btn-primary" onClick={() => copy(st.mcpCommand)}>复制命令</button>
              <button className="btn" onClick={() => setReveal((v) => !v)}>
                {reveal ? '隐藏 token' : '显示 token'}
              </button>
              <span className="spacer" />
              <span className="muted">
                装好后会多出 <span className="mono">dsh_ask</span> 与{' '}
                <span className="mono">dsh_review</span> 两个工具
              </span>
            </div>
            <div className="muted hint">
              命令里的 <span className="mono">&lt;Krill.app&gt;</span> 需替换成实际安装路径；
              开发模式下 shim 在项目的 <span className="mono">resources/bridge-mcp/index.mjs</span>。
              token 默认打码，是为了截图或投屏时不把它一起带出去。
            </div>
          </>
        )}
      </div>

      {/* ── 端点 ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">端点</div>
        <table className="tbl">
          <tbody>
            <tr>
              <td className="mono">GET /v1/docs</td>
              <td className="muted">自描述文档：当前模型、参数、示例、限制。调用方读一次就知道怎么用</td>
            </tr>
            <tr>
              <td className="mono">POST /v1/ask</td>
              <td className="muted">{'{prompt, cwd?}'} —— 干活的那个</td>
            </tr>
          </tbody>
        </table>
        <div className="muted hint">
          刻意只有两个，也刻意不让调用方指定模型或 profile。
          代码审查这类便利封装放在 MCP shim 侧本地组装，不往服务端加端点。
          <br />
          任务本身失败（非零退出）返回 HTTP 200 带 <span className="mono">exitCode</span> ——
          调用方要能拿到输出自己判断，而不是只收到一个错误码。
        </div>
      </div>
    </div>
  )
}
