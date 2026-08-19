import { parseDocument } from '../node_modules/yaml/dist/index.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function hasCustomTags(raw: string): boolean {
  try {
    const doc = parseDocument(raw)
    const msgs = [...doc.warnings, ...doc.errors].map((w: { message: string }) => w.message.toLowerCase())
    return msgs.some((m: string) => m.includes('tag'))
  } catch { return true }
}

const real = readFileSync(join(homedir(), '.dsh/profiles/web/cordis.patch.yml'), 'utf8')
const cases: Array<[string, string, boolean]> = [
  ['真实 profile（注释里含 `!!js` 字样）', real, false],
  ['纯空数组', '[]\n', false],
  ['普通条目', '- id: a\n  disabled: true\n', false],
  ['注释里写 !!js', '# !!js expressions allowed\n[]\n', false],
  ['真的自定义标签', '- id: a\n  config: !!js/function "function(){}"\n', true],
  ['另一种自定义标签', '- !!custom\n  id: a\n', true],
]
let bad = 0
for (const [name, raw, want] of cases) {
  const got = hasCustomTags(raw)
  const ok = got === want
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${got}${ok ? '' : ` (期望 ${want})`}`)
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
