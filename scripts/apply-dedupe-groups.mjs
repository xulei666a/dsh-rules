#!/usr/bin/env node
/**
 * 按人工确认的语义重复组合并规则（groups 文件格式见 im/.dsh-install/dedupe-groups.json）。
 * 用法: node scripts/apply-dedupe-groups.mjs <groups.json> [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULES_DIR, loadRules, saveRules, syncAgents, auditRules } from '../lib/store.js'

const args = process.argv.slice(2)
const groupsFile = args.find((a) => !a.startsWith('--'))
const DRY = args.includes('--dry')
if (!groupsFile) { console.error('用法: node scripts/apply-dedupe-groups.mjs <groups.json> [--dry]'); process.exit(1) }

const payload = JSON.parse(fs.readFileSync(groupsFile, 'utf8').replace(/^\uFEFF/, ''))
const groups = payload.groups ?? payload
const rules = loadRules()
const byKey = new Map(rules.map((r) => [r.key, r]))

const plan = []
for (const g of groups) {
  if (!byKey.has(g.survivor)) { console.warn('[skip] survivor 不存在：' + g.survivor); continue }
  const merged = (g.merged ?? []).filter((k) => byKey.has(k) && k !== g.survivor)
  if (!merged.length) continue
  const sourceParts = new Set()
  for (const k of [g.survivor, ...merged]) for (const s of String(byKey.get(k).source ?? '').split(/[;；]/)) if (s.trim()) sourceParts.add(s.trim())
  plan.push({ ...g, merged, value: g.value || byKey.get(g.survivor).value, source: [...sourceParts].join('; ').slice(0, 300) })
}

if (!plan.length) { console.log('没有可合并的组。'); process.exit(0) }
const removeSet = new Set(plan.flatMap((p) => p.merged))
const next = rules.filter((r) => !removeSet.has(r.key)).map((r) => {
  const hit = plan.find((p) => p.survivor === r.key)
  return hit ? { ...r, value: hit.value, source: hit.source, updatedAt: new Date().toISOString() } : r
})

console.log(`将合并 ${plan.length} 组 / 去掉 ${removeSet.size} 条：${rules.length} → ${next.length}`)
for (const p of plan) console.log(`  ● 保留 ${p.survivor} ← 合并 ${p.merged.join(', ')}`)
if (DRY) { console.log('[dry] 未写入'); process.exit(0) }

saveRules(next)
fs.mkdirSync(RULES_DIR, { recursive: true })
fs.writeFileSync(path.join(RULES_DIR, 'dedupe-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), before: rules.length, after: next.length, plan }, null, 2), 'utf8')
const sync = syncAgents({ silent: true })
const a = auditRules(next)
console.log('[sync]', JSON.stringify(sync))
console.log('[audit]', JSON.stringify({ total: a.total, active: a.active, pending: a.pendingCount, conflicts: a.conflicts.length }))
