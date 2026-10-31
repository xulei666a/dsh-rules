#!/usr/bin/env node
/**
 * 从现有资产导入准则（默认 dry-run；--apply 才写）
 *
 * 来源:
 *   - ~/.dsh/style-packs/active.json                  → style.<domain>
 *   - ~/.dsh/skills/skill-vet/SKILL.md                → skill.auto_install_min_score / skill.daily_budget
 *   - AGENTS.md / EXPERIENCE.md / style-packs / skill-vet 的既有准则
 *   - ~/.dsh/AGENTS.md                                → paths.*（识别硬编码 Windows 路径，pending）
 *
 * 用法: node import-rules.mjs [--apply] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOME, DSH_DIR, loadRules, upsertRule, syncAgents } from '../lib/store.js'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

const candidates = []
const add = (c) => candidates.push({ scope: 'global', priority: undefined, status: 'pending', category: undefined, ...c })
const exists = (key) => loadRules().some((r) => r.key === key)
const same = (key, value) => loadRules().some((r) => r.key === key && String(r.value) === String(value))

// 1) style-packs active
try {
  const active = JSON.parse(fs.readFileSync(path.join(DSH_DIR, 'style-packs', 'active.json'), 'utf8'))
  for (const [domain, pack] of Object.entries(active)) {
    add({ key: `style.${domain}`, value: `${domain}/${pack}`, category: 'style', source: 'style-packs/active.json' })
  }
} catch { /* 没有 style-packs 就跳过 */ }

// 2) skill-vet 阈值
try {
  const t = fs.readFileSync(path.join(HOME, '.dsh', 'skills', 'skill-vet', 'SKILL.md'), 'utf8')
  const min = t.match(/≥\s*(\d{2})/)?.[1]
  if (min) add({ key: 'skill.auto_install_min_score', value: `${min}`, category: 'skill', source: 'skill-vet/SKILL.md' })
  const budget = t.match(/每天最多体检\s*(\d+)\s*个[、,]\s*装\s*(\d+)\s*个/)
  if (budget) add({ key: 'skill.daily_budget', value: `体检 ${budget[1]} 个/天，装 ${budget[2]} 个/天`, category: 'skill', source: 'skill-vet/SKILL.md' })
} catch { /* 没装 skill-vet 就跳过 */ }

// 3) AGENTS.md 里"约定类"路径（只收带默认/放/保存/下载/安装/输出语境的，跳过项目清单与敏感路径）
try {
  const text = fs.readFileSync(path.join(DSH_DIR, 'AGENTS.md'), 'utf8')
  const beforeMark = text.split('<!-- dsh-rules:begin')[0]
  const picked = []
  for (const line of beforeMark.split(/\r?\n/)) {
    if (!/(默认|首选|放到|保存到|下载|安装到|输出到|交付物|工作文档)/.test(line)) continue
    const m = line.match(/[A-Za-z]:\\[^\s，。；、""''`)>\]]+/)
    if (!m) continue
    const p = m[0].replace(/[.。，、；:)]+$/, '')
    if (/\.secrets|secret|token|credential|password|\.env/i.test(p)) continue
    if (/\.(md|json|yaml|yml|exe|cmd|log|js|mjs|py|txt|key)$/i.test(p)) continue
    if (picked.includes(p)) continue
    picked.push(p)
    if (picked.length >= 8) break
  }
  picked.forEach((p, i) => add({ key: `paths.convention_${i + 1}`, value: p, category: 'paths', source: 'AGENTS.md', status: 'pending' }))
} catch { /* 没有 AGENTS.md 就跳过 */ }

// 差异计算 + 输出
const changes = candidates.filter((c) => !same(c.key, c.value))
const out = { apply: APPLY, candidates: candidates.length, changes: changes.length, items: changes }
if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`候选规则 ${candidates.length} 条，其中需要写入/更新 ${changes.length} 条（${APPLY ? 'APPLY' : 'dry-run'}）`)
  for (const c of changes) console.log(`  ${exists(c.key) ? '~' : '+'} ${c.key} = ${c.value}   [${c.category ?? 'auto'} · ${c.source}]`)
  if (!changes.length) console.log('  （全部已是最新，无需写入）')
  const pendingCount = changes.filter((c) => c.status === 'pending').length
  if (pendingCount) console.log(`  其中 ${pendingCount} 条是 pending（来源已识别但值待人工校准）`)
}
if (APPLY && changes.length) {
  // 保守：新规则写 pending；已存在的规则不降级，保留原状态
  const existing = new Map(loadRules().map((r) => [r.key, r]))
  for (const c of changes) {
    const cur = existing.get(c.key)
    upsertRule({ ...c, status: cur ? cur.status : (c.status ?? 'pending'), sync: false }, { sync: false })
  }
  const r = syncAgents({ silent: true })
  console.log('[import-rules] 已写入并同步 AGENTS.md：' + JSON.stringify(r))
}
