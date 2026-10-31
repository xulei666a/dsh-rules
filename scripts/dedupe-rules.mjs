#!/usr/bin/env node
/**
 * 第二轮语义去重（中文友好）：用字符二元组 Jaccard 找近重复，人工确认后按 merge-list 合并。
 *
 * 用法:
 *   node scripts/dedupe-rules.mjs                 # 只扫描并打印候选簇
 *   node scripts/dedupe-rules.mjs --apply         # 按内置 merge-list 合并（保守白名单）
 *   node scripts/dedupe-rules.mjs --json          # JSON 输出候选簇
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULES_DIR, loadRules, saveRules, syncAgents, auditRules } from '../lib/store.js'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

// 字符二元组（中文友好），去掉标点与空白
const bigrams = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
const jac = (A, B) => {
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}
const len = (s) => String(s ?? '').replace(/\s+/g, '').length
// 不可比的规则：短值/纯地址/同一 key
const uncomparable = (r) => len(r.value) < 16 || r.category === 'paths' || /^[A-Za-z]:[\\/]/.test(String(r.value))

const rules = loadRules()
const T = rules.map((r) => ({ r, v: bigrams(r.value), t: bigrams(r.title || '') }))
const pairs = []
for (let i = 0; i < T.length; i++) {
  for (let j = i + 1; j < T.length; j++) {
    const a = T[i]; const b = T[j]
    if (a.r.key === b.r.key || uncomparable(a.r) || uncomparable(b.r)) continue
    // 同 key 前缀族（如 style.ppt.minimal_tech.* vs style.ppt.*）不自动判重
    const v = jac(a.v, b.v)
    const t = jac(a.t, b.t)
    if (v >= 0.55 || (v >= 0.4 && t >= 0.6)) pairs.push({ score: +(v * 0.7 + t * 0.3).toFixed(3), v: +v.toFixed(2), t: +t.toFixed(2), a: i, b: j })
  }
}
pairs.sort((x, y) => y.score - x.score)
const parent = rules.map((_, i) => i)
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
const union = (x, y) => { const a = find(x); const b = find(y); if (a !== b) parent[a] = b }
for (const p of pairs) union(p.a, p.b)
const clusters = new Map()
for (let i = 0; i < rules.length; i++) { const k = find(i); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(i) }
const multi = [...clusters.values()].filter((c) => c.length > 1)

// 保守白名单：只有语义上确实同义的才合并（key 列表按语义组）
const MERGE_GROUPS = [
  ['workflow.batch_audit', 'workflow.batch_change_audit'],
  ['skill.hard_risk_reject', 'skill.hard_risk_gate'],
  ['workflow.memory_recalibration', 'workflow.self_maintain'],
]

const plan = []
for (const idxs of multi) {
  const group = idxs.map((i) => rules[i])
  const keys = group.map((r) => r.key)
  const wl = MERGE_GROUPS.find((g) => g.filter((k) => keys.includes(k)).length >= 2)
  const survivor = group.find((r) => (wl ? wl[0] === r.key : false)) ?? [...group].sort((a, b) => len(b.value) - len(a.value))[0]
  const losers = group.filter((r) => r !== survivor)
  const sources = new Set()
  for (const r of group) for (const s of String(r.source ?? '').split(/[;；]/)) if (s.trim()) sources.add(s.trim())
  plan.push({
    whitelisted: Boolean(wl),
    survivor: survivor.key,
    merged: losers.map((r) => r.key),
    title: group.find((r) => r.title)?.title ?? survivor.title,
    value: String(survivor.value),
    sourceMerged: [...sources].join('; ').slice(0, 300),
  })
}

if (JSON_OUT) console.log(JSON.stringify({ total: rules.length, clusters: multi.length, plan }, null, 2))
else {
  console.log(`规则 ${rules.length} 条，字符二元组相似度命中 ${multi.length} 簇：`)
  for (const p of plan) {
    console.log(`\n${p.whitelisted ? '✅ 白名单' : '⚠️ 需人工确认'} 保留 ${p.survivor}`)
    for (const m of p.merged) console.log(`   合并 ${m}`)
    console.log(`   值: ${p.value.slice(0, 100)}…`)
  }
}

if (APPLY) {
  const toApply = plan.filter((p) => p.whitelisted)
  if (!toApply.length) { console.log('\n没有白名单内的合并项，未改动。'); process.exit(0) }
  const removeSet = new Set(toApply.flatMap((p) => p.merged))
  const next = rules.filter((r) => !removeSet.has(r.key)).map((r) => {
    const hit = toApply.find((p) => p.survivor === r.key)
    return hit ? { ...r, title: hit.title || r.title, value: hit.value, source: hit.sourceMerged, updatedAt: new Date().toISOString() } : r
  })
  saveRules(next)
  const report = { generatedAt: new Date().toISOString(), before: rules.length, after: next.length, merged: toApply }
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(path.join(RULES_DIR, 'dedupe-report.json'), JSON.stringify(report, null, 2), 'utf8')
  const sync = syncAgents({ silent: true })
  const a = auditRules(next)
  console.log(`\n[applied] ${rules.length} → ${next.length} 条（合并 ${removeSet.size} 条）`)
  console.log('[sync]', JSON.stringify(sync))
  console.log('[audit]', JSON.stringify({ total: a.total, active: a.active, pending: a.pendingCount, conflicts: a.conflicts.length }))
}
