import { orphanDisabledIds, bundleInsertIds } from '../src/main/plugins/patch-orphans.ts'

/**
 * 「孤儿 disabled 条目」的判定。
 *
 * 2026-09-05 踩的坑：web profile 里 `- id: vision, disabled: true` 是用户故意停用
 * vision pack 的行（它的代码级补丁在 rc.1 运行时上没打上，启用即崩）。体检把它判成
 * 孤儿 —— 因为 node_modules 里没有叫 `vision` 的包（真实包名是 @deepseek-ai/dsh-vision，
 * 而 `vision` 是 bundle 自己 cordis.patch.yml 里 insert 的 loader id）—— 一键修复
 * 把两行清掉，后端启动即崩。判定必须把「已装 bundle 声明过的 id」也算作存在。
 */
const visionBundlePatch = `# 注释不影响
- insert:
    - id: vision
      name: '@deepseek-ai/dsh-vision'
      config:
        enabled: false
    - id: ui-vision
      name: '@deepseek-ai/dsh-client-ui-vision'
`

const entries = [
  { id: 'vision', disabled: true },
  { id: 'ui-vision', disabled: true },
  { id: 'dsh-super-injector', disabled: true },
  { id: 'gone-forever', disabled: true },
  { id: 'live-row', name: '@x/live' },
  { disabled: true },
]
const packages = new Set(['dsh-super-injector'])
const exists = (id: string): boolean => packages.has(id)

const cases: Array<[string, unknown, unknown]> = [
  ['从 bundle 的 patch 文本里收 insert 的 id（含嵌套）', bundleInsertIds(visionBundlePatch), ['vision', 'ui-vision']],
  ['空列表 / 空文本不炸', [bundleInsertIds('[]\n'), bundleInsertIds('')], [[], []]],
  ['坏 YAML 当作没声明（宁可少判孤儿，不能多判）', bundleInsertIds('- insert: [\n'), []],
  ['bundle 声明过的 disabled 行不是孤儿；包存在的也不是；两边都没有的才是',
    orphanDisabledIds(entries, exists, new Set(bundleInsertIds(visionBundlePatch))),
    ['gone-forever']],
  ['没有 bundle 声明时回到只看包名的老行为',
    orphanDisabledIds(entries, exists, new Set()),
    ['vision', 'ui-vision', 'gone-forever']],
  ['没 disabled 的行和没 id 的行从不算孤儿',
    orphanDisabledIds([{ id: 'a', name: 'x' }, { disabled: true }], () => false, new Set()),
    []],
  ['同一个孤儿 id 出现两次只报一次',
    orphanDisabledIds([{ id: 'g', disabled: true }, { id: 'g', disabled: true }], () => false, new Set()),
    ['g']],
]

let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`))
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
