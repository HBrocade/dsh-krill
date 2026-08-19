import { maxVersion, compareVersions, isUpgrade } from '../src/shared/semver.ts'

// 真实数据：@deepseek-ai/dsh-base 在 npm 上的 versions 全集
const real = ["0.0.1-rc.1","0.0.1-rc.2","0.0.1-rc.3","0.0.1-rc.5","0.1.0-rc.2","0.1.0-rc.3","0.1.0-rc.6","0.1.0-rc.7"]
const latestTag = "0.0.1-rc.1"   // registry 的 dist-tags.latest（错的）

const cases: Array<[string, unknown, unknown]> = [
  ['maxVersion(真实全集)',            maxVersion(real),                    '0.1.0-rc.7'],
  ['latest 标签是错的',               latestTag !== maxVersion(real),      true],
  ['rc.6 → rc.7 是升级',              isUpgrade('0.1.0-rc.6','0.1.0-rc.7'), true],
  ['rc.7 → latest标签 不是升级',       isUpgrade('0.1.0-rc.7', latestTag),  false],
  ['0.0.1-rc.5 < 0.1.0-rc.2',        compareVersions('0.0.1-rc.5','0.1.0-rc.2') < 0, true],
  ['rc.2 < rc.10（数字段按数字比）',    compareVersions('0.1.0-rc.2','0.1.0-rc.10') < 0, true],
  ['预发布 < 正式版',                  compareVersions('1.0.0-rc.1','1.0.0') < 0, true],
  ['非法版本被跳过',                   maxVersion(['abc','0.1.0','x']),      '0.1.0'],
  ['全非法返回 null',                  maxVersion(['abc','x']),              null],
  ['禁用预发布时全 rc 挑不出',          maxVersion(real,{allowPrerelease:false}), null],
]
let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`))
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
