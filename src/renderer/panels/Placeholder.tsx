/** 尚未实现的面板占位。明确标出属于哪个阶段，避免看起来像坏了。 */
export function Placeholder(props: { title: string; phase: string }): React.JSX.Element {
  return (
    <div className="panel">
      <h1 className="panel-head">{props.title}</h1>
      <p className="panel-sub">这个面板属于 {props.phase} 阶段，尚未实现。</p>
      <div className="card">
        <p style={{ margin: 0, color: 'var(--text-dim)' }}>
          实施顺序见项目根目录的 <code>PLAN.md</code>。当前已完成 P0（脚手架）与 P1（外壳骨架）。
        </p>
      </div>
    </div>
  )
}
