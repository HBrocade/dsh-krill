import { parse } from '../node_modules/yaml/dist/index.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cases: Array<[string, string]> = [
  ['真实 web profile', readFileSync(join(homedir(), '.dsh/profiles/web/cordis.patch.yml'), 'utf8')],
  ['空数组', '[]\n'],
  ['正常列表', '- id: a\n  disabled: true\n- id: b\n'],
  ['重复 id', '- id: a\n- id: a\n- id: b\n'],
  ['两个顶层值(应报错)', '[]\n- id: a\n'],
]
for (const [name, raw] of cases) {
  try {
    const d: unknown = parse(raw)
    const arr = d === null || d === undefined ? [] : d
    if (!Array.isArray(arr)) { console.log(`${name}: 顶层不是数组`); continue }
    const ids = (arr as Array<{ id?: string }>).map(e => e.id).filter(Boolean)
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
    console.log(`${name}: ${arr.length} 条，id=[${ids.join(',')}]，重复=[${[...new Set(dup)].join(',')}]`)
  } catch (e) {
    console.log(`${name}: 解析失败 → ${(e as Error).message.split('\n')[0]}`)
  }
}
