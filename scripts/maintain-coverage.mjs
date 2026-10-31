#!/usr/bin/env node
/**
 * 适用面维护：新规则/新学习到的准则怎么自动归类，以及"哪些还没定"的可见队列。
 *
 * 用法：
 *   node scripts/maintain-coverage.mjs            # 报告（不写盘）
 *   node scripts/maintain-coverage.mjs --apply    # 把置信 ≥0.6 的建议落成显式字段并同步 AGENTS
 *   node scripts/maintain-coverage.mjs --min 0.9  # 只落定高置信（分类表）建议
 *   node scripts/maintain-coverage.mjs --json     # 机器可读
 *
 * 判定链（lib/coverage.js）：显式 → 分类表 → 关键词域 → 类别兜底 → 兜底 default + 待复核。
 * 关键点：**没有"静默默认"**——任何推断置信不足的规则都会进 needsReview，并在 AGENTS 托管段里显式提示。
 */
import { loadRules, coverageCounts, coverageReview, acceptCoverageSuggestions, auditRules } from '../lib/store.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes('--' + k)
const val = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d }

const rules = loadRules()
const counts = coverageCounts(rules)
const review = coverageReview(rules)
const audit = auditRules(rules)
const bySource = audit.coverage?.bySource || {}

if (has('json')) {
  console.log(JSON.stringify({ total: rules.length, counts, bySource, review }, null, 2))
  process.exit(0)
}

console.log(`规则 ${rules.length} 条：默认 ${counts.default} / 局部 ${counts.local} / 待复核 ${counts.needsReview}`)
console.log('适用面来源：' + Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' / '))
if (!review.length) {
  console.log('✅ 全部规则适用面明确（没有待复核项）')
  process.exit(0)
}
console.log(`\n待复核 ${review.length} 条（当前按推断值生效）：`)
for (const x of review) console.log(`  - ${x.key}（${x.title}）→ ${x.suggestion.coverage}${x.suggestion.appliesTo?.length ? ':' + x.suggestion.appliesTo.join('+') : ''} · ${x.reason} · 置信 ${x.confidence}`)

if (!has('apply')) {
  console.log('\n落定建议：加 --apply（默认 ≥0.6）；只想要高置信：--apply --min 0.9')
  process.exit(0)
}
const min = val('min', 0.6)
const r = acceptCoverageSuggestions({ minConfidence: min })
console.log(`\n已落定 ${r.accepted} 条（阈值 ${min}）：${r.keys.slice(0, 12).join('、')}${r.keys.length > 12 ? ' …' : ''}`)
console.log(`剩余待复核 ${r.remaining} 条${r.remaining ? '（需人工 rules_set 指定 coverage/appliesTo）' : ''}`)
