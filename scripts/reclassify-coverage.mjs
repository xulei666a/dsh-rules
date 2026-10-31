#!/usr/bin/env node
/**
 * 重新判定既有规则的「适用面」（保守口径）。
 * 只重算"非人工确认"的规则（coverageSource 不是 explicit / review）；
 * 人工确认过的（含复核落定）一律不动。
 *
 * 用法: node scripts/reclassify-coverage.mjs          预览
 *       node scripts/reclassify-coverage.mjs --apply  落库（先备份 rules.jsonl）
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadRules, upsertRule, syncAgents, loadCoverageMap, auditRules, coverageCounts, RULES_DIR, HOME } from '../lib/store.js'
import { inferCoverage } from '../lib/coverage.js'

const APPLY = process.argv.includes('--apply')
const IGNORE_MAP = process.argv.includes('--ignore-map')   // 危险：连分类表一起丢掉重算，会产生大量噪音，仅供对照
const KEEP_SOURCES = new Set(['explicit', 'review'])
const map = IGNORE_MAP ? {} : loadCoverageMap()
const rules = loadRules()

const changes = []
for (const r of rules) {
  if (KEEP_SOURCES.has(r.coverageSource)) continue
  const bare = { key: r.key, title: r.title, value: r.value, category: r.category, source: r.source, status: r.status }
  const inf = inferCoverage(bare, map)
  const oldCov = r.coverage || 'default'
  const oldDomains = (r.appliesTo || []).join(',')
  const newDomains = (inf.appliesTo || []).join(',')
  if (oldCov === inf.coverage && oldDomains === newDomains && Boolean(r.needsReview) === Boolean(inf.needsReview)) continue
  changes.push({ rule: r, oldCov, oldDomains, oldReview: Boolean(r.needsReview), inf })
}

const counts = new Map()
for (const c of changes) {
  const k = `${c.oldCov}${c.oldDomains ? '(' + c.oldDomains + ')' : ''} → ${c.inf.coverage}${c.inf.appliesTo.length ? '(' + c.inf.appliesTo.join(',') + ')' : ''}${c.inf.needsReview ? ' · 待复核' : ''}`
  counts.set(k, (counts.get(k) || 0) + 1)
}

console.log(`规则总数 ${rules.length}；可重判（非人工确认）${rules.filter((r) => !KEEP_SOURCES.has(r.coverageSource)).length}；需要变化 ${changes.length} 条${APPLY ? '（APPLY）' : '（预览，未写入）'}${IGNORE_MAP ? '  [已忽略分类表，仅对照用]' : ''}`)
if (!IGNORE_MAP && !changes.length) console.log('提示：分类表（coverage-map.json）覆盖了全部规则，重判无变化；要强制丢掉分类表看对照，加 --ignore-map（不建议落库）。')
for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} 条：${k}`)
for (const c of changes.slice(0, 15)) console.log(`  - ${c.rule.key}: ${c.oldCov} → ${c.inf.coverage}${c.inf.appliesTo.length ? '(' + c.inf.appliesTo.join(',') + ')' : ''}`)
if (changes.length > 15) console.log(`  … 其余 ${changes.length - 15} 条省略`)
const willReview = changes.filter((c) => c.inf.needsReview && !c.oldReview).length
const leaveReview = changes.filter((c) => !c.inf.needsReview && c.oldReview).length
console.log(`待复核：新增 ${willReview} 条，解除 ${leaveReview} 条`)

if (!APPLY) process.exit(0)
if (!changes.length) { console.log('没有需要写入的变化。'); process.exit(0) }

const backupDir = path.join(RULES_DIR, 'backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = path.join(backupDir, `rules-${stamp}.jsonl`)
fs.copyFileSync(path.join(RULES_DIR, 'rules.jsonl'), backup)
console.log('已备份:', backup.replace(HOME, '~'))

let n = 0
for (const c of changes) {
  upsertRule({
    ...c.rule,
    coverage: c.inf.coverage,
    appliesTo: c.inf.appliesTo,
    coverageSource: c.inf.coverageSource,
    coverageConfidence: c.inf.confidence,
    needsReview: c.inf.needsReview,
  }, { sync: false })
  n++
}
const sync = syncAgents({ silent: true })
const after = loadRules()
console.log(`已写入 ${n} 条；同步 AGENTS: ${JSON.stringify(sync)}`)
console.log('新分布:', JSON.stringify(coverageCounts(after)))
console.log('审计:', JSON.stringify(auditRules(after).counts ?? auditRules(after)))
