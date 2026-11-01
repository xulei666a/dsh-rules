#!/usr/bin/env node
/**
 * dsh-rules CLI（与插件共用 lib/store.js）
 *
 * 用法:
 *   node cli.mjs list [--all] [--category paths] [--keyword ppt]
 *   node cli.mjs get <key>
 *   node cli.mjs set <key> <value> [--category C] [--scope S] [--priority N] [--source X] [--status active|pending|deprecated] [--no-sync]
 *   node cli.mjs remove <key> [--scope S]
 *   node cli.mjs resolve [--task "做PPT"] [--keys a,b]
 *   node cli.mjs audit
 *   node cli.mjs history [--key K] [--limit N]   # 改动记录（最新在前）
 *   node cli.mjs sync [--dry]
 *   node cli.mjs export [--format markdown|table] [--out 文件]
 *   node cli.mjs import [--apply]        # 从现有资产导入（默认 dry-run）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadRules, upsertRule, removeRule, resolveEffective, auditRules,
  renderDigest, renderMarkdown, syncAgents,
  healthReport, listAgentsBackups, restoreAgentsBackup, loadProjectRules, PROJECT_FILE,
  coverageCounts, coverageDomains, domainLabel, coverageReview, acceptCoverageSuggestions,
  loadUsage, setSessionRules, loadSessionRules,
  loadHistory, historyCount,
  setSessionProfile, loadSessionProfile, clearSessionProfile, listSessionProfiles, sessionDefaultRules,
  pinSessionRules,
  RULES_DIR, saveRules,
} from '../lib/store.js'
import { tagsOf } from '../lib/tags.js'
import { checkSources, harvestPlan, recordSources, discoverSources, loadLedger, addRoot, addIgnore, sourceRootSummary } from '../lib/sources.js'
import { listSchemes, getScheme, schemeView, rulesOfNode, createScheme, renameScheme, deleteScheme, addNode, renameNode, deleteNode, moveNode, moveRule, resetDefaultScheme } from '../lib/tree.js'
import { routeTask, routeTaskSemantic } from '../lib/routing.js'
import { embeddingInstalled, embeddingsBuilt, ensureRuleEmbeddings, CACHE_FILE } from '../lib/embedding.js'
import { collectCandidates, collectRules } from '../lib/collect.js'
import { scanIssues } from '../lib/issues.js'

const UI_FILE = fileURLToPath(new URL('../lib/ui.html', import.meta.url))

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'list'
const positional = []
const opt = {}
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) opt[k] = true
    else { opt[k] = next; i++ }
  } else positional.push(a)
}
const P = (r) => `${r.status === 'active' ? ' ' : r.status === 'pending' ? '?' : '-'} ${r.key} = ${r.value}   [${r.category}/${r.scope}${r.priority !== undefined ? ' p' + r.priority : ''} · ${r.coverage === 'local' ? '局部:' + (r.appliesTo || []).join('+') : '默认'} · ${r.source}]`

try {
  if (cmd === 'list') {
    let rules = loadRules()
    if (!opt.all) rules = rules.filter((r) => r.status === 'active')
    if (opt.category) rules = rules.filter((r) => r.category === opt.category)
    if (opt.coverage) rules = rules.filter((r) => (r.coverage || 'default') === opt.coverage)
    if (opt.domain) rules = rules.filter((r) => (r.appliesTo || []).includes(opt.domain))
    if (opt.keyword) { const kw = String(opt.keyword).toLowerCase(); rules = rules.filter((r) => (r.key + r.value + r.category).toLowerCase().includes(kw)) }
    const cov = coverageCounts(loadRules())
    console.log(`共 ${rules.length} 条规则（${opt.all ? '含 pending/deprecated' : '仅 active'}；全库默认 ${cov.default} / 局部 ${cov.local}）`)
    for (const r of rules.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key))) console.log(P(r))
  } else if (cmd === 'collect') {
    if (opt['list-sources']) {
      const c = collectCandidates({ includePlugins: opt.plugins !== false })
      const per = {}
      for (const x of c) per[x.source] = (per[x.source] || 0) + 1
      console.log(`候选 ${c.length} 条，来源 ${Object.keys(per).length} 个：`)
      for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
    } else {
      const r = collectRules({ dryRun: Boolean(opt['dry-run']), includePlugins: opt.plugins !== false, resetSuppressed: Boolean(opt['reset-suppressed']) })
      const per = Object.entries(r.perSource).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('、')
      console.log(`${r.dryRun ? '预览（未写入）' : '已收录'}：候选 ${r.candidates} → 新增 ${r.added}，跳过重复 ${r.skipped}；已抑制删除项 ${r.suppressedSkipped || 0}；当前库 ${loadRules().length} 条`)
      console.log('来源：' + per)
    }
  } else if (cmd === 'reset') {
    const all = loadRules()
    if (!opt.yes) {
      console.log(`将清空全部 ${all.length} 条规则（清空前会自动备份 rules.jsonl）。确认请加 --yes：`)
      console.log('  node scripts/cli.mjs reset --yes')
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const src = path.join(RULES_DIR, 'rules.jsonl')
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(RULES_DIR, `rules.jsonl.bak-${stamp}`))
      saveRules([])
      const s = syncAgents({ silent: true })
      console.log(`已清空为 0 条；备份：rules.jsonl.bak-${stamp}；AGENTS 托管段：${s.changed ? '已更新' : '无变化'}`)
    }
  } else if (cmd === 'issues') {
    const i = scanIssues()
    console.log(`问题台账：共 ${i.total} 个（高 ${i.bySeverity.high} / 中 ${i.bySeverity.medium} / 低 ${i.bySeverity.low}）`)
    for (const g of i.groups) {
      console.log(`\n■ ${g.owner} · ${g.kind}（${g.count} 个，${g.severity}）`)
      console.log(`  建议：${g.suggestion}`)
      for (const it of g.items.slice(0, Number(opt.limit) || 3)) console.log(`  - ${it.key}${it.detail ? '：' + it.detail : ''}`)
    }
  } else if (cmd === 'history') {
    const entries = loadHistory({ key: opt.key ? String(opt.key) : null, limit: Number(opt.limit) || 30 })
    if (!entries.length) console.log('没有改动记录')
    else {
      const label = { create: '新增', update: '修改', remove: '删除' }
      console.log(`共 ${historyCount()} 条记录，以下 ${entries.length} 条（最新在前）`)
      for (const e of entries) {
        console.log(`\n${String(e.at).replace('T', ' ').slice(0, 19)} · ${label[e.action] || e.action} · ${e.title || e.key}（${e.key}）`)
        for (const c of e.changes || []) console.log(`  - ${c.label}：「${String(c.from).slice(0, 100)}」→「${String(c.to).slice(0, 100)}」`)
      }
    }
  } else if (cmd === 'coverage') {
    const rules = loadRules()
    const counts = coverageCounts(rules)
    const domains = coverageDomains()
    const byDomain = {}
    for (const r of rules) if (r.coverage === 'local') for (const d of r.appliesTo || []) byDomain[d] = (byDomain[d] || 0) + 1
    const sub = positional[0] || (opt.domain ? 'list' : 'summary')
    if (sub === 'review' || opt.review) {
      const review = coverageReview(rules)
      if (!review.length) console.log('✅ 没有待复核的适用面（全部规则有明确来源）')
      else {
        console.log(`待复核 ${review.length} 条（当前按推断值生效）：`)
        for (const x of review) console.log(`  - ${x.key}（${x.title}）→ 建议 ${x.suggestion.coverage}${x.suggestion.appliesTo?.length ? ':' + x.suggestion.appliesTo.join('+') : ''} · 来源 ${x.reason} · 置信 ${x.confidence}`)
        console.log('\n落定：coverage accept [--min-confidence 0.6]；逐条改：set <key> <value> --coverage local --appliesTo ppt')
      }
    } else if (sub === 'accept' || opt.accept) {
      const r = acceptCoverageSuggestions({ minConfidence: opt['min-confidence'] === undefined ? 0.6 : Number(opt['min-confidence']) })
      console.log(r.accepted ? `已落定 ${r.accepted} 条（剩余待复核 ${r.remaining}）` : `没有达到阈值的待复核项（剩余 ${r.remaining}）`)
      if (r.accepted) console.log(JSON.stringify(r.synced))
    } else if (sub === 'stats') {
      const bySource = {}; for (const r of rules) bySource[r.coverageSource || 'unknown'] = (bySource[r.coverageSource || 'unknown'] || 0) + 1
      console.log(`默认 ${counts.default} / 局部 ${counts.local} / 待复核 ${counts.needsReview}`)
      console.log('来源：' + Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' / '))
    } else if (opt.domain || sub === 'list' && opt.domain) {
      const list = rules.filter((r) => r.coverage === 'local' && (r.appliesTo || []).includes(opt.domain))
      console.log(`域 ${opt.domain}（${domainLabel(opt.domain)}）：${list.length} 条局部规则`)
      for (const r of list) console.log(P(r))
    } else {
      console.log(`适用面：默认（常驻注入 AGENTS.md）${counts.default} 条 / 局部（按任务域路由）${counts.local} 条 / 待复核 ${counts.needsReview} 条`)
      console.log('任务域：')
      for (const [id, label] of Object.entries(domains)) console.log(`  ${id.padEnd(12)} ${label}（${byDomain[id] || 0} 条）`)
      console.log('子命令：coverage review | coverage accept [--min-confidence 0.6] | coverage stats | coverage --domain ppt')
    }
  } else if (cmd === 'sources') {
    const sub = positional[0] || 'check'
    if (sub === 'record') {
      const only = opt.only ? String(opt.only).split(',').map((s) => s.trim()).filter(Boolean) : discoverSources().map((s) => s.id)
      const r = recordSources({ harvested: only, note: String(opt.note ?? '') })
      console.log(`已登记 ${r.recorded} 个来源，标记已采集 ${r.harvested} 个 → ~/.dsh/rules/sources.json`)
    } else if (sub === 'plan') {
      const p = harvestPlan()
      if (!p.new.length && !p.changed.length && !p.removed.length) console.log(`✅ 没有未采集的来源（共 ${p.total} 个）`)
      else {
        if (p.new.length) { console.log(`新来源 ${p.new.length} 个：`); for (const s of p.new) console.log(`  + [${s.kind}] ${s.name}  ${s.path}`) }
        if (p.changed.length) { console.log(`有变化 ${p.changed.length} 个：`); for (const s of p.changed) console.log(`  ~ [${s.kind}] ${s.name}（上次采集 ${s.harvestedAt || '未采集'}）`) }
        if (p.removed.length) { console.log(`已消失 ${p.removed.length} 个：`); for (const s of p.removed) console.log(`  - [${s.kind}] ${s.name}`) }
        console.log('采集：' + p.suggested)
      }
    } else if (sub === 'roots') {
      const s = sourceRootSummary()
      console.log(`DSH 目录：${s.dshDir}`)
      console.log('自动探测的根：')
      for (const r of s.roots) console.log(`  [${r.kind}] ${r.path}${r.real !== r.path ? ' → ' + r.real : ''}`)
      console.log(`自定义根（${s.extraRoots.length}）：` + (s.extraRoots.length ? s.extraRoots.map((r) => `${r.kind}=${r.path}`).join('、') : '（无）'))
      console.log(`忽略（${s.ignore.length}）：${s.ignore.join('、') || '（无）'}`)
      console.log(`配置文件：${s.configFile}`)
    } else if (sub === 'add-root') {
      const [kind, ...rest] = positional.slice(1)
      const p = rest.join(' ')
      if (!kind || !p) { console.error('用法: sources add-root <kind> <目录>'); process.exit(2) }
      const roots = addRoot(kind.replace(/\/$/, ''), p)
      console.log(`已加入自定义根 ${kind}=${path.resolve(p)}（当前 ${roots.length} 个）`)
    } else if (sub === 'ignore') {
      const pat = positional.slice(1).join(' ')
      if (!pat) { console.error('用法: sources ignore <子串>'); process.exit(2) }
      console.log(`已忽略包含「${pat}」的来源（共 ${addIgnore(pat).length} 条）`)
    } else if (sub === 'list') {
      const all = discoverSources({ force: true }); const ledger = loadLedger()
      console.log(`当前来源 ${all.length} 个（台账 ${Object.keys(ledger.sources || {}).length} 条，更新于 ${ledger.updatedAt || '从未'}）：`)
      for (const s of all) console.log(`  [${s.kind}] ${s.name}${ledger.sources?.[s.id] ? (ledger.sources[s.id].status === 'harvested' ? ' · 已采集' : ledger.sources[s.id].status === 'stale' ? ' · 已失效' : ' · 待采集') : ' · 未登记'}`)
    } else {
      const g = checkSources()
      console.log(`来源闸口：共 ${g.total} 个 · 未登记 ${g.new.length} · 有变化 ${g.changed.length} · 已消失 ${g.removed.length}`)
      if (g.new.length) console.log('新来源：' + g.new.map((s) => s.name).join('、'))
      if (g.changed.length) console.log('变化：' + g.changed.map((s) => s.name).join('、'))
      if (!g.new.length && !g.changed.length) console.log('✅ 来源与台账一致')
      console.log('子命令：sources list | sources roots | sources add-root <kind> <目录> | sources ignore <子串> | sources plan | sources record')
    }
  } else if (cmd === 'get') {
    const key = positional[0]
    const rules = loadRules().filter((r) => r.key === key)
    if (!rules.length) { console.error('没找到：' + key); process.exit(1) }
    for (const r of rules) console.log(P(r))
  } else if (cmd === 'set') {
    const [key, ...rest] = positional
    if (!key || !rest.length) { console.error('用法: set <key> <value>'); process.exit(2) }
    const res = upsertRule({
      key, value: rest.join(' '),
      category: opt.category, scope: opt.scope, priority: opt.priority === undefined ? undefined : Number(opt.priority),
      source: opt.source, status: opt.status,
      coverage: opt.coverage,
      appliesTo: typeof opt.appliesTo === 'string' ? opt.appliesTo.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    }, { sync: false })
    console.log('已保存：' + P(res.rule))
    if (!opt['no-sync']) console.log(JSON.stringify(syncAgents({ silent: true })))
  } else if (cmd === 'remove') {
    const key = positional[0]
    if (!key) { console.error('用法: remove <key> [--scope S]'); process.exit(2) }
    const r = removeRule(key, String(opt.scope ?? 'global'))
    console.log(r.removed ? '已删除 ' + key : '没找到 ' + key)
    if (r.removed) console.log(JSON.stringify(syncAgents({ silent: true })))
  } else if (cmd === 'resolve') {
    const list = resolveEffective(loadRules(), {
      task: opt.task ? String(opt.task) : '',
      keys: opt.keys ? String(opt.keys).split(',') : null,
      project: opt.project ? String(opt.project) : '',
      session: opt.tag ? String(opt.tag) : '',
    })
    console.log(`生效 ${list.length} 条`)
    for (const r of list) console.log(`- ${r.key} = ${r.value}  [${r.category} · ${r.source}]`)
  } else if (cmd === 'audit') {
    console.log(JSON.stringify(auditRules(loadRules()), null, 2))
  } else if (cmd === 'sync') {
    const r = syncAgents({ dryRun: Boolean(opt.dry), full: opt.full ? true : undefined })
    console.log(JSON.stringify(r, null, 2))
  } else if (cmd === 'export') {
    const fmt = String(opt.format ?? 'markdown')
    const text = fmt === 'table' ? renderMarkdown(loadRules()) : renderDigest(loadRules(), { full: Boolean(opt.full) })
    if (opt.out) { fs.writeFileSync(String(opt.out), text, 'utf8'); console.log('已写入 ' + opt.out) }
    else console.log(text)
  } else if (cmd === 'report') {
    console.log(JSON.stringify(healthReport(loadRules(), { project: opt.project ? String(opt.project) : '' }), null, 2))
  } else if (cmd === 'rollback') {
    if (opt.list || !opt.restore) {
      const list = listAgentsBackups()
      console.log(list.length ? '备份（' + list.length + '）：\n' + list.map((x) => '- ' + x).join('\n') : '没有 dsh-rules 备份')
    }
    if (opt.restore) {
      const r = restoreAgentsBackup(String(opt.restore))
      console.log('已回滚 AGENTS.md ← ' + r.restored + '（' + r.bytes + ' bytes）')
    }
  } else if (cmd === 'project') {
    const dir = String(opt.project ?? '')
    if (!dir) { console.error('用法: project [list|set|resolve] --project <目录> [key value]'); process.exit(2) }
    const file = path.join(dir, PROJECT_FILE)
    const sub = positional[0] ?? 'list'
    if (sub === 'set') {
      const [key, ...rest] = positional.slice(1)
      if (!key || !rest.length) { console.error('用法: project set <key> <value> --project <目录>'); process.exit(2) }
      let j = { rules: [] }
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
      const list = Array.isArray(j) ? j : (j.rules ?? [])
      const rule = { key, value: rest.join(' '), category: opt.category, status: opt.status ?? 'active', source: 'project file' }
      const i = list.findIndex((r) => r.key === key)
      if (i >= 0) list[i] = rule; else list.push(rule)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ rules: list }, null, 2) + '\n', 'utf8')
      console.log(`已写入 ${file}：${key} = ${rule.value}`)
    } else if (sub === 'resolve') {
      const list = resolveEffective(loadRules(), { project: dir })
      console.log(`项目 ${dir} 生效 ${list.length} 条：`)
      for (const r of list) console.log(`- ${r.key} = ${r.value}  [${r.scope} · ${r.source}]`)
    } else {
      const list = loadProjectRules(dir)
      console.log(`${file}: ${list.length} 条`)
      for (const r of list) console.log(`- ${r.key} = ${r.value}  [${r.category} · ${r.status}]`)
    }
  } else if (cmd === 'usage') {
    console.log(JSON.stringify(loadUsage(), null, 2))
  } else if (cmd === 'ui') {
    const html = fs.readFileSync(UI_FILE, 'utf8')
    if (opt.out) { fs.writeFileSync(String(opt.out), html, 'utf8'); console.log('已写出 ' + opt.out + '（' + html.length + ' chars）') }
    else console.log('UI 文件：' + UI_FILE + '（' + html.length + ' chars；插件加载后可用 GET /dsh-rules/ui 打开）')
  } else if (cmd === 'session') {
    const sub = String(positional[0] ?? '')
    const tag = String(opt.tag ?? '')
    // 按条翻「本对话生效」：session pin|unpin <key...> --tag <id>；session pins --tag <id>
    if (sub === 'pin' || sub === 'unpin') {
      const tid = String(opt.tag ?? opt.session ?? '').trim()
      const keys = positional.slice(1)
      if (!tid) { console.error('缺少 --tag <会话id>'); process.exit(2) }
      if (!keys.length) { console.error(`用法：session ${sub} <key> [更多key ...] --tag <会话id>`); process.exit(2) }
      const known = new Set(loadRules().map((r) => r.key))
      const bad = keys.filter((k) => !known.has(k))
      if (bad.length) { console.error('这些 key 不存在：' + bad.join(', ')); process.exit(2) }
      try {
        const pins = pinSessionRules(tid, keys, sub === 'pin')
        console.log(`${sub === 'pin' ? '已在本对话生效' : '已取消本对话生效'}：${keys.join('、')}（${tid}；按条 ${pins.length} 条）`)
      } catch (e) { console.error('操作失败：' + e.message); process.exit(1) }
    } else if (sub === 'pins') {
      const tid = String(opt.tag ?? opt.session ?? '').trim()
      if (!tid) { console.error('缺少 --tag'); process.exit(2) }
      const rules = sessionDefaultRules(tid)
      if (!rules.length) console.log(`${tid}：没有额外生效的局部规则`)
      else for (const r of rules) console.log(`- ${r.key} = ${String(r.value).slice(0, 90)}`)
    } else if (sub === 'defaults') {
      const list = listSessionProfiles()
      if (!list.length) console.log('没有本对话默认。用法：session default set ppt --tag <会话id>')
      else for (const p of list) {
        const bits = []
        if (p.domain) bits.push('默认域 ' + domainLabel(p.domain))
        if ((p.pins || []).length) bits.push('按条 ' + p.pins.length + ' 条')
        console.log(`${p.tag} → ${bits.join(' + ')}${p.label ? '（' + p.label + '）' : ''} · 到期 ${String(p.expiresAt).slice(0, 10)} · ${sessionDefaultRules(p.tag).length} 条规则`)
      }
    } else if (sub === 'default') {
      const action = String(positional[1] ?? '').trim()
      const domain = String(positional[2] ?? opt.domain ?? '').trim()
      const tid = String(opt.tag ?? opt.session ?? '').trim()
      if (!tid) { console.error('缺少 --tag <会话id>'); process.exit(2) }
      if (action === 'set') {
        if (!domain) { console.error('用法：session default set <domain> --tag <会话id> [--label 备注] [--ttl 7]'); process.exit(2) }
        try {
          const p = setSessionProfile(tid, { domain, label: opt.label, ttlDays: Number(opt.ttl) || undefined })
          console.log(`已设定 ${tid} → ${domainLabel(p.domain)}（到期 ${String(p.expiresAt).slice(0, 10)}；${sessionDefaultRules(tid).length} 条规则仅本会话当默认）`)
        } catch (e) { console.error('设定失败：' + e.message); process.exit(1) }
      } else if (action === 'show') {
        const p = loadSessionProfile(tid)
        if (!p) console.log(`${tid}：没有默认域，也没有按条生效的规则`)
        else {
          const rules = sessionDefaultRules(tid)
          const bits = []
          if (p.domain) bits.push('默认域 ' + domainLabel(p.domain))
          if ((p.pins || []).length) bits.push('按条 ' + p.pins.length + ' 条')
          console.log(`${tid} → ${bits.join(' + ') || '（空）'}（到期 ${String(p.expiresAt).slice(0, 10)}；${rules.length} 条规则仅本会话生效）`)
          for (const r of rules) console.log(`  - ${r.key} = ${String(r.value).slice(0, 90)}`)
        }
      } else if (action === 'clear') {
        console.log(clearSessionProfile(tid) ? '已清除 ' + tid : '没找到 ' + tid)
      } else { console.error('用法：session default set|show|clear <domain> --tag <会话id>'); process.exit(2) }
    } else {
      const oldTag = String(opt.tag ?? positional[0] ?? '')
      if (!oldTag) { console.error('用法: session [list|set] --tag <标签> [key value]；或 session defaults / default set|show|clear'); process.exit(2) }
      if (positional[0] === 'set') {
        const [key, ...rest] = positional.slice(1)
        if (!key || !rest.length) { console.error('用法: session set <key> <value> --tag <标签>'); process.exit(2) }
        const cur = loadSessionRules(oldTag).map((r) => ({ key: r.key, value: r.value, category: r.category, status: r.status }))
        const rule = { key, value: rest.join(' '), category: opt.category, status: opt.status ?? 'active' }
        const i = cur.findIndex((r) => r.key === key)
        if (i >= 0) cur[i] = rule; else cur.push(rule)
        setSessionRules(oldTag, cur)
        console.log(`会话 ${oldTag} 覆盖 ${cur.length} 条`)
      } else {
        const list = loadSessionRules(oldTag)
        console.log(`会话 ${oldTag}：${list.length} 条`)
        for (const r of list) console.log(`- ${r.key} = ${r.value}`)
      }
    }
  } else if (cmd === 'route') {
    const task = positional.join(' ') || String(opt.task ?? '')
    if (!task) { console.error('用法: route "<任务描述>" [--lexical] [--topK N]'); process.exit(2) }
    const r = opt.lexical ? routeTask(task, { topK: opt.topK ? Number(opt.topK) : 12 }) : await routeTaskSemantic(task, { topK: opt.topK ? Number(opt.topK) : 12 })
    console.log(`任务：${r.task}`)
    console.log(`路由模式：${r.mode ?? 'lexical'}${r.reason ? '（' + r.reason + '）' : ''}`)
    console.log(`领域标签：${r.tags.join('、') || '（无）'}`)
    console.log(`建议领域：${r.domains.join('、') || '（无）'}`)
    for (const x of r.rules) console.log(`  [${x.score.toFixed(2)}] ${x.key} | ${x.title} → ${String(x.value).slice(0, 80)}`)
    if (r.hasBranchConflict && Array.isArray(r.decisions)) {
      console.log('\n⚠ 决策冲突（同一决策点有多个分支，运行时必须让用户选）：')
      for (const d of r.decisions.filter((x) => x.conflict)) {
        console.log(`  · ${d.decision}`)
        for (const o of d.options) console.log(`      - ${o.option}（${o.kind === 'node' ? '文件夹' : '规则'} · ${(o.rules || []).length} 条）`)
      }
    }
  } else if (cmd === 'embed') {
    const sub = positional[0] ?? 'status'
    if (sub === 'status') {
      console.log('已安装依赖:', embeddingInstalled(), '| 缓存已构建:', embeddingsBuilt(), '| 缓存文件:', CACHE_FILE)
      if (embeddingsBuilt()) {
        const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
        console.log('模型:', j.model, '| 向量数:', Object.keys(j.vectors || {}).length, '| 更新时间:', j.updatedAt)
      } else {
        console.log('未构建：node scripts/setup-embed.mjs 然后 node scripts/build-embeddings.mjs')
      }
    } else if (sub === 'build') {
      const t0 = Date.now()
      const r = await ensureRuleEmbeddings(loadRules(), { force: Boolean(opt.force), log: (m) => console.log('  ' + m) })
      console.log(`完成：新算 ${r.rebuilt} 条，缓存 ${r.total} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } else { console.error('用法: embed status|build [--force]'); process.exit(2) }
  } else if (cmd === 'groups' || cmd === 'tree') {
    const rules = loadRules()
    const sub = positional[0] ?? 'list'
    const schemeArg = String(opt.scheme ?? 'default')
    if (sub === 'list') {
      for (const s of listSchemes(rules)) console.log(`${s.builtin ? '★' : '＋'} ${s.id}  ${s.title}  (${s.total} 条，未分类 ${s.unassigned})${s.desc ? '  — ' + s.desc : ''}`)
    } else if (sub === 'show') {
      const scheme = getScheme(String(positional[1] ?? schemeArg))
      const nodeId = positional[2] ? String(positional[2]) : null
      if (nodeId) {
        const list = rulesOfNode(scheme, rules, nodeId)
        console.log(`${scheme.title} / ${nodeId}：${list.length} 条`)
        for (const r of list) console.log(`- ${r.key}（${r.title || ''}）`)
      } else {
        const view = schemeView(scheme, rules)
        console.log(`${view.title}（${view.id}）${view.builtin ? '［内置］' : ''} 合计 ${view.total}，未分类 ${view.unassigned}`)
        const pr = (nodes, depth = 0) => { for (const n of nodes) { console.log('  '.repeat(depth) + `- ${n.title}（${n.own}/${n.total}）[${n.id}]`); pr(n.children, depth + 1) } }
        pr(view.roots)
      }
    } else if (sub === 'scheme') {
      const op = positional[1]
      if (op === 'create') { const s = createScheme({ title: positional.slice(2).join(' '), desc: String(opt.desc ?? '') }); console.log('已建方案：' + s.id + ' ' + s.title) }
      else if (op === 'rename') { const s = renameScheme(String(positional[2] ?? ''), { title: positional.slice(3).join(' '), desc: opt.desc }); console.log('已改名：' + s.title) }
      else if (op === 'delete') console.log('已删除方案：' + deleteScheme(String(positional[2] ?? '')).deleted)
      else if (op === 'reset') { const s = resetDefaultScheme(); console.log('已恢复内置方案：' + s.id) }
      else { console.error('用法: groups scheme create|rename|delete|reset ...'); process.exit(2) }
    } else if (sub === 'node') {
      const op = positional[1]
      if (op === 'add') { const n = addNode({ schemeId: schemeArg, parentId: opt.parent ? String(opt.parent) : null, title: positional.slice(2).join(' ') }); console.log('已加节点：' + n.id + ' ' + n.title) }
      else if (op === 'rename') { renameNode({ schemeId: schemeArg, nodeId: String(positional[2] ?? ''), title: positional.slice(3).join(' ') }); console.log('已重命名节点') }
      else if (op === 'delete') console.log('已删除节点：' + deleteNode({ schemeId: schemeArg, nodeId: String(positional[2] ?? '') }).removed.join(','))
      else if (op === 'move') { moveNode({ schemeId: schemeArg, nodeId: String(positional[2] ?? ''), parentId: opt.parent ? String(opt.parent) : null }); console.log('已移动节点') }
      else { console.error('用法: groups node add|rename|delete|move ...'); process.exit(2) }
    } else if (sub === 'move') {
      const key = positional[1]
      const target = positional[2]
      if (!key || !target) { console.error('用法: groups move <规则key> <节点id|__unassigned__> [--scheme default]'); process.exit(2) }
      moveRule({ schemeId: schemeArg, key, nodeId: target === '__unassigned__' ? null : target })
      console.log(`已移动 ${key} → ${target}`)
    } else {
      console.error('未知子命令：' + sub + '（list/show/scheme/node/move）'); process.exit(2)
    }
  } else {
    console.error('未知命令：' + cmd + '\n可用：list / get / set / remove / resolve / audit / sync / export / report / rollback / project / session / usage / ui / route / groups（tree 同义）')
    process.exit(2)
  }
} catch (e) {
  console.error('出错：' + (e?.message ?? e))
  process.exit(1)
}
