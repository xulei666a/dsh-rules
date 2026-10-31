#!/usr/bin/env node
/**
 * 批量提案合并器：把 teammates 产出的项目提案统一入库，并生成覆盖账。
 *
 * 输入: ~/.dsh/rules/proposals/*.json 或 im/.dsh-install/proposals/*.json
 *       每个文件 = { batch, rules: [...], coverage: [{file, ingested, ignored}] }
 * 输出: 规则库 upsert（同 key 覆盖、语义近重复跳过）、~/.dsh/rules/coverage.json、AGENTS 同步
 * 用法: node scripts/merge-proposals.mjs [--dir <目录>] [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOME, RULES_DIR, loadRules, upsertRule, syncAgents, auditRules } from '../lib/store.js'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const dirArg = args.indexOf('--dir')
const CANDIDATE_DIRS = [
  dirArg >= 0 ? args[dirArg + 1] : null,
  path.join(HOME, '.dsh', 'rules', 'proposals'),
  'D:/Agent/ai_engine/im/.dsh-install/proposals',
].filter(Boolean)

const tokenize = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter((w) => w.length > 1)
const jaccard = (a, b) => {
  const A = new Set(tokenize(a)); const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const files = []
for (const dir of CANDIDATE_DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f))
}
if (!files.length) { console.error('没有找到提案文件（proposals/*.json）'); process.exit(1) }

const existing = loadRules()
const existingKeys = new Set(existing.map((r) => r.key))
const coveredByExisting = new Set()
const added = []
const skippedDup = []
const coverageAll = new Map()
const warnings = []

for (const file of files) {
  let p
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    p = JSON.parse(raw)
  } catch (e) { warnings.push(`解析失败 ${file}: ${e.message}`); continue }
  for (const c of p.coverage ?? []) {
    const key = normPath(c.file)
    const prev = coverageAll.get(key) ?? { file: c.file, batches: [], ingested: 0, ignored: [] }
    prev.batches.push(p.batch ?? path.basename(file))
    prev.ingested += Number(c.ingested) || 0
    prev.ignored.push(...(c.ignored ?? []))
    coverageAll.set(key, prev)
  }
  for (const r of p.rules ?? []) {
    if (!r.key || !r.value) { warnings.push('规则缺 key/value：' + JSON.stringify(r).slice(0, 120)); continue }
    if (existingKeys.has(r.key) && (r.status ?? 'active') !== 'active') { skippedDup.push({ key: r.key, reason: 'key 已存在' }); continue }
    if (existingKeys.has(r.key)) {
      const cur = existing.find((x) => x.key === r.key)
      if (jaccard(cur.value, r.value) > 0.5) { skippedDup.push({ key: r.key, reason: 'key 已存在且语义相近' }); continue }
    }
    let near = null
    for (const a of [...existing, ...added]) {
      if (jaccard(a.value, r.value) >= 0.78) { near = a; break }
    }
    if (near) { skippedDup.push({ key: r.key, reason: '语义近重复 → ' + near.key }); coveredByExisting.add(r.key); continue }
    added.push({ ...r, sources: r.sources ?? [r.source] })
    existingKeys.add(r.key)
  }
}

if (!DRY) {
  for (const r of added) {
    upsertRule({
      key: r.key,
      title: r.title ?? '',
      value: r.value,
      category: r.category,
      // 保守：新入库默认 pending（待校准），复核后再转 active
      status: r.status ?? 'pending',
      source: [r.source, ...(r.sources ?? []).filter((s) => s !== r.source)].filter(Boolean).join('; ').slice(0, 300),
    }, { sync: false })
  }
  const sync = syncAgents({ silent: true })
  const audit = auditRules(loadRules())
  // 覆盖账：合并 harvest 索引，标出每个来源的状态
  let harvestIndex = null
  try { harvestIndex = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'harvest', 'index.json'), 'utf8')) } catch {}
  const allSources = (harvestIndex?.sources ?? []).map((s) => ({ raw: s.file, key: normPath(s.file) }))
  for (const s of allSources) if (!coverageAll.has(s.key)) warnings.push('来源没有覆盖记录：' + s.raw.replace(HOME, '~'))
  const coverage = {
    generatedAt: new Date().toISOString(),
    harvestSources: allSources.length,
    coveredSources: allSources.filter((s) => coverageAll.has(s.key)).length,
    rulesAdded: added.length,
    rulesSkippedDuplicate: skippedDup.length,
    warnings,
    coverage: [...coverageAll.values()].sort((a, b) => normPath(a.file).localeCompare(normPath(b.file))),
  }
  fs.writeFileSync(path.join(RULES_DIR, 'coverage.json'), JSON.stringify(coverage, null, 2), 'utf8')
  console.log(`提案文件 ${files.length} 个 → 新增 ${added.length} 条，跳过重复 ${skippedDup.length} 条；同步 ${JSON.stringify(sync)}`)
  console.log('audit：' + JSON.stringify({ total: audit.total, active: audit.active, pending: audit.pendingCount, conflicts: audit.conflicts.length }))
  console.log(`覆盖：${coverage.coveredSources}/${coverage.harvestSources} 个来源有覆盖记录；warnings ${warnings.length}`)
  for (const w of warnings.slice(0, 20)) console.log('  ⚠ ' + w)
} else {
  console.log(`[dry] 提案文件 ${files.length} 个，将新增 ${added.length} 条，跳过重复 ${skippedDup.length} 条`)
  for (const s of skippedDup.slice(0, 15)) console.log('  - ' + s.key + '：' + s.reason)
}
