/**
 * dsh-rules · host 侧（Cordis 插件）
 *
 * 职责：给模型 7 个工具 + 把生效规则同步成 ~/.dsh/AGENTS.md 的托管段（always-on）。
 * 存储/解析逻辑全在 ./store.js（CLI 与插件共用同一份代码）。
 *
 * 工具返回约定：defineTool 必须声明 output { schema, render }；
 *   这里统一用字符串输出（output.schema = string），render 包成 text block。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  loadRules, upsertRule, removeRule, resolveEffective, auditRules,
  renderDigest, renderMarkdown, syncAgents, CATEGORIES,
  healthReport, listAgentsBackups, restoreAgentsBackup, loadProjectRules, setSessionRules, loadSessionRules, PROJECT_FILE,
  loadCoverageMap, coverageDomains, domainLabel, coverageCounts,
  coverageReview, acceptCoverageSuggestions,
  loadHistory, historyCount,
  setSessionProfile, loadSessionProfile, clearSessionProfile, listSessionProfiles, sessionDefaultRules, SESSION_TTL_DAYS,
  pinSessionRules, RULES_DIR,
} from './store.js'
import { tagsOf, tagsOfStrict } from './tags.js'
import { listSchemes, getScheme, schemeView, computeAssignments, rulesOfNode, createScheme, renameScheme, deleteScheme, addNode, renameNode, deleteNode, moveNode, moveRule, resetDefaultScheme, hasUndo, undoLast, SCHEMES_FILE, loadSchemes, saveSchemes, findNode, flattenNodes } from './tree.js'
import { routeTask, routeTaskSemantic } from './routing.js'
import { checkSources, harvestPlan, recordSources, discoverSources, loadLedger, addRoot, addIgnore, sourceRootSummary, sourceRoots, SOURCES_FILE } from './sources.js'
import { sendToAssistant, getAssistantChat, resetAssistant, assistantBusy, buildAssistantPrompt } from './assistant.js'
import { scanIssues, issuesSummary } from './issues.js'
import { collectCandidates, collectRules } from './collect.js'
import { inspectSkill, installSkill, draftRulesFromSkill, draftRuleFromText } from './skill-import.js'
import { buildTopology } from './topology.js'

export const name = 'dsh-rules'
export const inject = ['tools']

const PLUGIN_VERSION = '1.0.2'
const MAX_RETURN = 120
const UI_FILE = fileURLToPath(new URL('./ui.html', import.meta.url))

/* ---------------- 一键读取规则：读取进度（未读/已变更对比） ---------------- */
const READ_STATE_FILE = path.join(RULES_DIR, 'read-state.json')
const ruleStamp = (r) => String(r?.updatedAt || r?.createdAt || '')
function loadReadState() { try { return JSON.parse(fs.readFileSync(READ_STATE_FILE, 'utf8')) } catch { return null } }
function saveReadState(s) { try { fs.mkdirSync(RULES_DIR, { recursive: true }); fs.writeFileSync(READ_STATE_FILE, JSON.stringify(s, null, 2), 'utf8') } catch {} }
function readProgress() {
  const all = loadRules()
  const st = loadReadState()
  const fp = st?.fingerprints || {}
  const active = all.filter((r) => r.status === 'active')
  const unread = active.filter((r) => fp[r.key] !== ruleStamp(r))
  return { total: active.length, allCount: all.length, unread, lastReadAt: st?.lastReadAt || '', lastReadCount: st?.lastReadCount || 0 }
}

/* ---------- 读取规则 = 从历史快照/归档恢复全部可用规则 ---------- */
function discoverRuleArchives() {
  const out = []
  const seen = new Set()
  const add = (label, file) => {
    try {
      if (!file || seen.has(file) || !fs.existsSync(file)) return
      const rules = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter((r) => r && r.key)
      if (!rules.length) return
      seen.add(file)
      out.push({ label, file, dir: path.dirname(file), count: rules.length, mtime: fs.statSync(file).mtime.toISOString() })
    } catch {}
  }
  const dshDir = path.dirname(RULES_DIR)
  try {
    for (const name of fs.readdirSync(dshDir)) {
      if (!/^rules[._-](bak|backup|archive|fresh-test|pre-restore|snapshot)/i.test(name)) continue
      add(name, path.join(dshDir, name, 'rules.jsonl'))
    }
  } catch {}
  for (const sub of ['backups', 'archive']) {
    try {
      const dir = path.join(RULES_DIR, sub)
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        try {
          if (fs.statSync(p).isDirectory()) add(sub + '/' + name, path.join(p, 'rules.jsonl'))
          else if (/\.jsonl$/.test(name)) add(sub + '/' + name, p)
        } catch {}
      }
    } catch {}
  }
  return out.sort((a, b) => b.count - a.count || String(b.mtime).localeCompare(String(a.mtime)))
}
function restoreFromSource(file, { dryRun = false } = {}) {
  const raw = fs.readFileSync(file, 'utf8')
  const incoming = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((r) => r && r.key)
  const existing = loadRules()
  const byId = new Map(existing.map((r) => [r.id || ((r.scope || 'global') + '::' + r.key), r]))
  let added = 0
  let skipped = 0
  for (const r of incoming) {
    const id = r.id || ((r.scope || 'global') + '::' + r.key)
    if (byId.has(id)) { skipped++; continue }
    if (dryRun) { added++; continue }
    try { upsertRule({ ...r, sync: false }, { sync: false }); byId.set(id, r); added++ } catch { skipped++ }
  }
  let schemesRestored = false
  if (!dryRun) {
    try {
      const snapGroups = path.join(path.dirname(file), 'groups.json')
      if (fs.existsSync(snapGroups) && !fs.existsSync(SCHEMES_FILE)) {
        fs.mkdirSync(RULES_DIR, { recursive: true })
        fs.copyFileSync(snapGroups, SCHEMES_FILE)
        schemesRestored = true
      }
    } catch {}
    if (added) { try { syncAgents({ silent: true }) } catch {} }
  }
  return { file, incoming: incoming.length, added, skipped, dryRun, schemesRestored }
}

const asText = (title, data) => {
  if (data === undefined) return String(title)
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return `${title}\n${body}`
}
const brief = (r) => ({ key: r.key, value: r.value, category: r.category, scope: r.scope, priority: r.priority, source: r.source, status: r.status, coverage: r.coverage || 'default', ...(r.appliesTo?.length ? { appliesTo: r.appliesTo } : {}) })

const vTool = (spec) => defineTool({
  ...spec,
  description: `[dsh-rules v${PLUGIN_VERSION}] ` + String(spec.description ?? ''),
  output: spec.output ?? { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v ?? '') }] },
  execute: async (args = {}, exec) => {
    try { return await spec.execute(args, exec) } catch (e) { return 'dsh-rules 出错：' + (e?.message ?? String(e)) }
  },
})

/** 从工具执行上下文里尽力取当前会话 id（不同宿主版本字段可能不同） */
function sessionTagFromExec(exec) {
  const tries = [
    ['agent.sessionId', () => exec?.agent?.sessionId],
    ['agent.session.id', () => exec?.agent?.session?.id],
    ['agent.session.sessionId', () => exec?.agent?.session?.sessionId],
    ['agent.sessionInfo.id', () => exec?.agent?.sessionInfo?.id],
    ['agent.context.session.id', () => exec?.agent?.context?.session?.id],
    ['agent.threadId', () => exec?.agent?.threadId],
    ['exec.sessionId', () => exec?.sessionId],
  ]
  for (const [name, fn] of tries) {
    try {
      const v = fn()
      if (v && typeof v === 'string') return { tag: v, from: name }
    } catch {}
  }
  return { tag: '', from: '' }
}

const TOOLS = [
  vTool({
    name: 'rules_query',
    description: '查询统一准则（可按类别/关键词/适用面过滤）。做某件事之前先看有没有既定规则；默认规则常驻已注入 AGENTS.md，局部规则（coverage=local）只在相关任务里查。',
    parameters: {
      category: { type: 'string', description: `类别，可选 ${CATEGORIES.join(' / ')}` },
      keyword: { type: 'string', description: '关键词（匹配 key/title/value/category/tags/explain）' },
      coverage: { type: 'string', description: 'default（常驻）/ local（按任务域生效）；不填=全部' },
      appliesTo: { type: 'string', description: '任务域过滤，如 ppt / paper / blender / office / coding（命中该域的局部规则）' },
      includeInactive: { type: 'boolean', description: 'true 时连同 pending/deprecated 一起返回' },
      status: { type: 'string', description: '按状态过滤：active / pending / deprecated；pending=待校准（收集来未确认）' },
    },
    execute: async (args) => {
      const all = loadRules()
      const kw = String(args.keyword ?? '').trim().toLowerCase()
      const cov = String(args.coverage ?? '').trim()
      const domain = String(args.appliesTo ?? '').trim()
      let list = all.filter((r) => (args.includeInactive ? true : r.status === 'active'))
      const st = String(args.status ?? '').trim()
      if (st) list = list.filter((r) => r.status === st)
      if (args.category) list = list.filter((r) => r.category === args.category)
      if (cov) list = list.filter((r) => (r.coverage || 'default') === cov)
      if (domain) list = list.filter((r) => (r.appliesTo || []).includes(domain))
      if (kw) list = list.filter((r) => [r.key, r.title, r.value, r.category, (r.tags || []).join(' '), r.explain].join(' ').toLowerCase().includes(kw))
      const tag = [args.category ? `类别 ${args.category}` : '', cov ? `适用面 ${cov}` : '', domain ? `域 ${domainLabel(domain)}` : '', kw ? `关键词 ${args.keyword}` : ''].filter(Boolean).join('，')
      return asText(`找到 ${list.length} 条规则${tag ? `（${tag}）` : ''}：`, list.slice(0, MAX_RETURN).map(brief))
    },
  }),
  vTool({
    name: 'rules_resolve',
    description: '按任务描述解析「此刻生效的规则」：同 key 按优先级取胜，只留 active。做任务前用它拿上下文规则。',
    parameters: {
      task: { type: 'string', description: '任务描述，如「做一份 PPT」「安装软件」' },
      keys: { type: 'string', description: '只看这些 key（逗号分隔），可选' },
      project: { type: 'string', description: '项目目录（可选）：叠加该目录下 .dsh-rules.json 的项目级规则' },
      session: { type: 'string', description: '会话 tag（可选）：叠加会话级覆盖' },
    },
    execute: async (args, exec) => {
      const keys = String(args.keys ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const probe = sessionTagFromExec(exec)
      const sessionTag = String(args.session ?? '').trim() || probe.tag
      const list = resolveEffective(loadRules(), { task: String(args.task ?? ''), keys, project: String(args.project ?? ''), session: sessionTag })
      const profile = sessionTag ? loadSessionProfile(sessionTag) : null
      const note = profile ? `（本对话默认域：${domainLabel(profile.domain)}，该域 ${list.filter((r) => r.sessionDefault).length} 条规则在本会话内当默认）` : ''
      return asText(`生效规则 ${list.length} 条${args.task ? `（任务：${args.task}）` : ''}${args.project ? `（项目：${args.project}）` : ''}${note}：`, list.map((r) => `- ${r.key} = ${r.value}  [${r.category} · ${r.scope} · ${r.source}${r.sessionDefault ? ' · 本会话默认' : ''}]`))
    },
  }),
  vTool({
    name: 'rules_session',
    description: '管理「本对话生效」：「默认生效」的规则每个对话都生效；「仅当前对话」的规则平时不生效，用 op=pin 可以把指定的规则在本对话翻成生效（换对话 / 7 天自动失效，不写 AGENTS.md）。op=set domain=ppt 是整域一次性翻生效的快捷方式。用户说「把这条/这些设为这个对话生效」「这个对话默认按 PPT 来」时用它。',
    parameters: {
      op: { type: 'string', description: 'show（查看本对话生效情况）/ pin（按条翻生效）/ unpin（取消生效）/ pins（列出本会话额外生效的条）/ set（整域生效快捷）/ clear（全部取消）/ list（所有会话）' },
      keys: { type: 'string', description: 'op=pin/unpin 时的规则 key，逗号分隔，如 style.ppt.slide_size,tools.ppt' },
      domain: { type: 'string', description: 'op=set 时的任务域，如 ppt / paper / report / blender / coding' },
      label: { type: 'string', description: '备注（可选），如「做PPT的窗口」' },
      ttlDays: { type: 'number', description: '有效天数，默认 7' },
      session: { type: 'string', description: '会话 tag（可选）；不填会尝试从当前执行上下文自动取 session id' },
    },
    execute: async (args = {}, exec) => {
      const op = String(args.op ?? 'show').trim()
      const probe = sessionTagFromExec(exec)
      const tag = String(args.session ?? '').trim() || probe.tag
      const keys = String(args.keys ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (op === 'list') {
        const list = listSessionProfiles()
        if (!list.length) return '没有任何会话生效设置。用 rules_session op=pin keys=<key> 或 op=set domain=ppt。'
        return asText(`共 ${list.length} 个会话有生效设置：`, list.map((p) => `- ${p.tag} → ${p.domain ? '默认域 ' + domainLabel(p.domain) : ''}${(p.pins || []).length ? (p.domain ? ' + ' : '') + '按条 ' + p.pins.length + ' 条' : ''}${p.label ? '（' + p.label + '）' : ''} · 到期 ${String(p.expiresAt).slice(0, 10)}`))
      }
      if (op === 'clear') {
        if (!tag) return '缺少 session：请显式传 session tag'
        return clearSessionProfile(tag) ? `已清除本对话的全部生效设置（tag=${tag}）` : `没有找到会话设置（tag=${tag}）`
      }
      if (!tag) return `拿不到当前会话 id（探测字段：${probe.from || '无'}）。请显式传 session：任意稳定字符串，如 rules_session op=pin keys=tools.ppt session=我的PPT窗口`
      if (op === 'show') {
        const p = loadSessionProfile(tag)
        if (!p) return `本对话（tag=${tag}${probe.from ? '，来源 ' + probe.from : ''}）没有额外生效的局部规则；默认规则仍按全局常驻。`
        const rules = sessionDefaultRules(tag)
        const bits = []
        if (p.domain) bits.push(`默认域 ${domainLabel(p.domain)}`)
        if ((p.pins || []).length) bits.push(`按条生效 ${p.pins.length} 条`)
        return asText(`本对话生效：${bits.join(' + ')}${p.label ? '（' + p.label + '）' : ''}（tag=${tag}${probe.from ? '，来源 ' + probe.from : ''}；到期 ${String(p.expiresAt).slice(0, 10)}；共 ${rules.length} 条局部规则在本会话当默认）：`, rules.map((r) => `- ${r.key} = ${r.value}`))
      }
      if (op === 'pins') {
        const rules = sessionDefaultRules(tag)
        const p = loadSessionProfile(tag)
        if (!rules.length) return `本对话（tag=${tag}）没有额外生效的局部规则。`
        return asText(`本对话生效 ${rules.length} 条${p?.pins?.length ? `（其中按条 ${p.pins.length} 条）` : ''}：`, rules.map((r) => `- ${r.key} = ${r.value}`))
      }
      if (op === 'pin' || op === 'unpin') {
        if (!keys.length) return '缺少 keys（逗号分隔的规则 key），例如 rules_session op=pin keys=tools.ppt,style.ppt.slide_size'
        const known = new Set(loadRules().map((r) => r.key))
        const bad = keys.filter((k) => !known.has(k))
        if (bad.length) return `这些 key 不存在：${bad.join(', ')}`
        try {
          const pins = pinSessionRules(tag, keys, op === 'pin')
          const rules = sessionDefaultRules(tag)
          return asText(`${op === 'pin' ? '已在本对话生效' : '已取消本对话生效'}：${keys.join('、')}（tag=${tag}${probe.from ? '，自动来自 ' + probe.from : ''}；仅本会话，${SESSION_TTL_DAYS} 天 TTL）。本会话现在共 ${rules.length} 条局部规则当默认${pins.length ? `，按条 ${pins.length} 条` : ''}。`, rules.slice(0, 40).map((r) => `- ${r.key} = ${r.value}`))
        } catch (e) {
          return '操作失败：' + (e?.message ?? String(e))
        }
      }
      if (op !== 'set') return `未知 op：${op}（可用 show / pin / unpin / pins / set / clear / list）`
      if (!args.domain) return '缺少 domain（如 ppt / paper）；或改用 op=pin keys=... 按条生效'
      try {
        const p = setSessionProfile(tag, { domain: args.domain, label: args.label, ttlDays: args.ttlDays })
        const rules = sessionDefaultRules(tag)
        return asText(`已设定本对话默认域：${domainLabel(p.domain)}${p.label ? '（' + p.label + '）' : ''}（tag=${tag}${probe.from ? '，自动来自 ' + probe.from : ''}；只在本会话生效，${SESSION_TTL_DAYS} 天 TTL；其它对话不受影响）。该域规则 ${rules.length} 条，本会话内当默认：`, rules.slice(0, 40).map((r) => `- ${r.key} = ${r.value}`))
      } catch (e) {
        return '设定失败：' + (e?.message ?? String(e))
      }
    },
  }),
  vTool({
    name: 'rules_bulk',
    description: '批量操作多条准则：按条件选中一批（keys / key 前缀 / 类别 / 任务域 / 关键词），一次性改适用面、状态、在本对话翻生效，或批量移入某个分类节点（op=move）。适合「规则太多、不想一条条点」。默认 dryRun=true 只预览，确认后再 dryRun=false 落库。',
    parameters: {
      op: { type: 'string', description: 'pin（本对话生效）/ unpin（取消本对话生效）/ set_coverage（改适用面）/ set_status（改状态）/ move（批量移入分类节点）' },
      targetNode: { type: 'string', description: 'op=move 时的目标节点 id（可用 rules_groups op=show 查看）' },
      targetTitle: { type: 'string', description: 'op=move 时的目标节点名称（按名字找，如「待复核」「验证与证据」）' },
      keys: { type: 'string', description: '按 key 精确选（逗号分隔）；与其它条件可叠加' },
      keyPrefix: { type: 'string', description: '按 key 前缀选，如 style.ppt' },
      category: { type: 'string', description: '按类别选，如 style / tools / workflow' },
      appliesTo: { type: 'string', description: '按规则现有任务域选，如 ppt（只选 appliesTo 含该域的）' },
      query: { type: 'string', description: '按关键词模糊选（匹配 key / 名称 / 内容）' },
      coverage: { type: 'string', description: 'op=set_coverage 时的目标：default / local' },
      appliesToValue: { type: 'string', description: 'op=set_coverage 且 coverage=local 时的任务域，逗号分隔' },
      status: { type: 'string', description: 'op=set_status 时的目标：active / pending / deprecated' },
      dryRun: { type: 'boolean', description: '默认 true 只预览匹配结果；确认后再传 false 真正落库' },
      session: { type: 'string', description: '会话 tag（可选）；op=pin/unpin 时默认自动取当前会话 id' },
    },
    execute: async (args = {}, exec) => {
      const op = String(args.op ?? '').trim()
      if (!['pin', 'unpin', 'set_coverage', 'set_status', 'move'].includes(op)) return '缺少或未知 op（pin / unpin / set_coverage / set_status / move）'
      const dryRun = args.dryRun !== false
      const all = loadRules()
      const ks = String(args.keys ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const prefix = String(args.keyPrefix ?? '').trim()
      const cat = String(args.category ?? '').trim()
      const domain = String(args.appliesTo ?? '').trim()
      const q = String(args.query ?? '').trim().toLowerCase()
      if (!ks.length && !prefix && !cat && !domain && !q) return '至少给一个选择条件（keys / keyPrefix / category / appliesTo / query），否则会改到全库'
      let picked = all.filter((r) => {
        if (ks.length && !ks.includes(r.key)) return false
        if (prefix && !String(r.key).startsWith(prefix)) return false
        if (cat && r.category !== cat) return false
        if (domain && !(r.appliesTo || []).includes(domain)) return false
        if (q) {
          const hay = [r.key, r.title, r.value, r.explain].filter(Boolean).join(' ').toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      if (!picked.length) return '没有匹配的准则；换个条件试试（可先 rules_query 看有哪些 key）。'
      const sample = picked.slice(0, 10).map((r) => `- ${r.key} = ${String(r.value).slice(0, 60)}`)
      const head = `匹配 ${picked.length} 条${picked.length > 10 ? '（列出前 10 条）' : ''}`
      if (op === 'pin' || op === 'unpin') {
        const probe = sessionTagFromExec(exec)
        const tag = String(args.session ?? '').trim() || probe.tag
        if (!tag) return '拿不到当前会话 id：请显式传 session（任意稳定字符串）。'
        if (dryRun) return asText(`${head}——dryRun（未改动，会设为本对话${op === 'pin' ? '生效' : '取消生效'}，tag=${tag}）：`, sample)
        pinSessionRules(tag, picked.map((r) => r.key), op === 'pin')
        const now = sessionDefaultRules(tag)
        return asText(`已${op === 'pin' ? '在本对话生效' : '取消本对话生效'} ${picked.length} 条（tag=${tag}；本会话现共 ${now.length} 条局部规则当默认）：`, sample)
      }
      if (op === 'set_coverage') {
        const cov = String(args.coverage ?? '').trim()
        if (!['default', 'local'].includes(cov)) return 'op=set_coverage 需要 coverage=default 或 local'
        const domains = String(args.appliesToValue ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (cov === 'local' && !domains.length) return 'coverage=local 时要给 appliesToValue（如 ppt）；否则规则会变成没有任务域的局部规则'
        if (dryRun) return asText(`${head}——dryRun（未改动，将改为 ${cov}${domains.length ? '(' + domains.join(',') + ')' : ''}）：`, sample)
        for (const r of picked) upsertRule({ ...r, coverage: cov, appliesTo: cov === 'local' ? domains : [], coverageSource: 'explicit', needsReview: false }, { sync: false })
        const sync = syncAgents({ silent: true })
        return asText(`已把 ${picked.length} 条改为 ${cov}${domains.length ? '(' + domains.join(',') + ')' : ''}，并同步 AGENTS（${sync.changed ? '有更新' : '无变化'}）。`, sample)
      }
      if (op === 'move') {
        const target = String(args.targetNode ?? '').trim()
        const targetTitle = String(args.targetTitle ?? '').trim()
        if (!target && !targetTitle) return 'op=move 需要 targetNode（节点 id）或 targetTitle（节点名）'
        const schemes = loadSchemes()
        const scheme = schemes.find((s) => s.builtin) || schemes[0]
        if (!scheme) return '还没有分类方案，先用 rules_groups op=scheme-create 建一个。'
        let node = target ? findNode(scheme.nodes, target) : null
        if (!node && targetTitle) {
          const flat = flattenNodes(scheme.nodes)
          node = flat.find((x) => x.node.title === targetTitle)?.node || flat.find((x) => String(x.node.title).includes(targetTitle))?.node || null
        }
        if (!node) {
          const names = flattenNodes(scheme.nodes).map((x) => x.node.title).slice(0, 30).join('、')
          return `没找到目标分类「${target || targetTitle}」。现有节点：${names}`
        }
        if (dryRun) return asText(`${head}——dryRun（未改动，将移入「${node.title}」；确认后 dryRun=false）：`, sample)
        let ok = 0
        for (const r of picked) { try { moveRule({ schemeId: scheme.id, key: r.key, nodeId: node.id }); ok++ } catch {} }
        return asText(`已把 ${ok} 条移入「${scheme.title} → ${node.title}」。`, sample)
      }
      const st = String(args.status ?? '').trim()
      if (!['active', 'pending', 'deprecated'].includes(st)) return 'op=set_status 需要 status=active / pending / deprecated'
      if (dryRun) return asText(`${head}——dryRun（未改动，将改为 ${st}）：`, sample)
      for (const r of picked) upsertRule({ ...r, status: st }, { sync: false })
      const sync = syncAgents({ silent: true })
      return asText(`已把 ${picked.length} 条状态改为 ${st}，并同步 AGENTS（${sync.changed ? '有更新' : '无变化'}）。`, sample)
    },
  }),
  vTool({
    name: 'rules_set',
    description: '新增/修改一条准则（同 key 同 scope 覆盖）。改完会自动同步到 ~/.dsh/AGENTS.md 托管段。',
    parameters: {
      key: { type: 'string', description: '规则 key，如 paths.downloads、tools.ppt（字母开头，允许 . _ -）' },
      value: { type: 'string', description: '规则值（字符串；复杂对象用 JSON 字符串）' },
      category: { type: 'string', description: '类别，默认按 key 前缀推断' },
      scope: { type: 'string', description: 'global（默认）/ user / project:<路径>' },
      priority: { type: 'number', description: '优先级，越大越优先；默认 global=100 / project=300' },
      source: { type: 'string', description: '来源，默认 manual；建议写清楚（如 AGENTS.md#节、主人偏好）' },
      status: { type: 'string', description: 'active（默认）/ pending / deprecated' },
      coverage: { type: 'string', description: 'default（常驻，任何会话注入）/ local（只在对应任务域生效）' },
      appliesTo: { type: 'string', description: 'coverage=local 时的任务域，逗号分隔：ppt / paper / report / diagram / office / blender / coding / skill …' },
      explain: { type: 'string', description: '白话解释（给不懂的人看：这条讲什么、什么时候用、和哪些准则配套、不照做会怎样）；内容太短或太形式化时建议补上' },
      sync: { type: 'boolean', description: '是否立即同步 AGENTS.md，默认 true' },
    },
    execute: async (args) => {
      if (!args.key) return '缺少 key'
      const appliesTo = typeof args.appliesTo === 'string' && args.appliesTo.trim()
        ? args.appliesTo.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      const r = upsertRule({ ...args, appliesTo, sync: false }, { sync: false })
      const sync = args.sync === false ? null : syncAgents({ silent: true })
      return asText(`已保存 ${r.rule.key} = ${r.rule.value}（${r.rule.status}）${sync?.changed ? '，已同步 AGENTS.md' : ''}`, brief(r.rule))
    },
  }),
  vTool({
    name: 'rules_remove',
    description: '删除一条规则（按 key+scope），删完自动同步 AGENTS.md。',
    parameters: {
      key: { type: 'string', description: '规则 key' },
      scope: { type: 'string', description: '默认 global' },
    },
    execute: async (args) => {
      if (!args.key) return '缺少 key'
      const r = removeRule(String(args.key), String(args.scope ?? 'global'))
      return r.removed ? `已删除 ${args.scope ?? 'global'}::${args.key}（AGENTS.md 已同步）` : `没找到 ${args.scope ?? 'global'}::${args.key}`
    },
  }),
  vTool({
    name: 'rules_audit',
    description: '体检规则库：冲突（同 key 同优先级不同值）、pending 待校准、无来源、未知类别、按类别统计。',
    parameters: {},
    execute: async () => {
      const a = auditRules(loadRules())
      const cov = a.coverage || { default: 0, local: 0, byDomain: {} }
      const lines = [
        `总 ${a.total} 条（active ${a.active}，pending ${a.pendingCount}，deprecated ${a.deprecated}）`,
        `适用面：默认（常驻）${cov.default} 条 / 局部（按任务域）${cov.local} 条${cov.unclassified?.length ? '；未分类 ' + cov.unclassified.length + ' 条：' + cov.unclassified.slice(0, 8).join(', ') : ''}`,
        Object.keys(cov.byDomain || {}).length ? '局部域分布：' + Object.entries(cov.byDomain).sort((x, y) => y[1] - x[1]).map(([d, n]) => `${d}=${n}`).join(' / ') : '',
        a.conflicts.length ? `⚠️ 冲突 ${a.conflicts.length} 组：` + a.conflicts.map((c) => c.key).join(', ') : '✅ 无硬冲突',
        a.pending.length ? `待校准：` + a.pending.map((p) => p.key).join(', ') : '',
        `无来源 ${a.noSource} 条${a.unknownCategory.length ? '；未知类别：' + a.unknownCategory.join(',') : ''}`,
        '按类别：' + a.byCategory.map((x) => `${x.category}=${x.count}`).join(' / '),
      ].filter(Boolean)
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'rules_sync',
    description: '把当前规则渲染进 ~/.dsh/AGENTS.md 的托管段（幂等；内容没变不会写盘）。默认摘要模式（名称+短值，省 token）；full=true 写完整版（key = value）。',
    parameters: {
      dryRun: { type: 'boolean', description: 'true 时只预览不写' },
      full: { type: 'boolean', description: 'true 时写完整版（默认按 ~/.dsh/rules/config.json 的 digest 设置，缺省摘要）' },
    },
    execute: async (args) => {
      const r = syncAgents({ dryRun: Boolean(args.dryRun), full: args.full })
      const gate = checkSources()
      const pending = gate.new.length + gate.changed.length
      const gateHint = pending ? `；来源闸口：${gate.new.length} 个新来源 / ${gate.changed.length} 个变化未采集（rules_sources op=plan）` : ''
      return (r.changed ? (args.dryRun ? '预览：AGENTS.md 会更新' : `已同步 AGENTS.md（${r.bytes} bytes${r.backup ? '，备份 ' + r.backup.split(/[\\/]/).pop() : ''}）`) : '内容一致，无需更新') + gateHint
    },
  }),
  vTool({
    name: 'rules_sources',
    description: '来源闸口：登记"准则来源"（技能目录/插件技能/AGENTS/经验库/风格包/配置），对比台账给出 new（新学/新装的技能，还没采集）、changed（技能更新过，规则可能过时）、removed（技能被删）。op=list 列来源，op=check 只看差异，op=plan 出采集计划，op=record 把当前来源全部登记（采集后调用；也可只登记指定的）。',
    parameters: {
      op: { type: 'string', description: 'list | check（默认）| plan | record' },
      only: { type: 'string', description: 'op=record 时只登记这些 id（逗号分隔）；留空=全部' },
      note: { type: 'string', description: 'op=record 时写入台账的备注' },
    },
    execute: async (args) => {
      const op = String(args.op ?? 'check')
      const gate = checkSources()
      if (op === 'roots') {
        const s = sourceRootSummary()
        return [
          `DSH 目录：${s.dshDir}`,
          '自动探测的根：',
          ...s.roots.map((r) => `- [${r.kind}] ${r.path}${r.real !== r.path ? ' → ' + r.real : ''}`),
          '',
          `自定义根（${s.extraRoots.length}）：` + (s.extraRoots.length ? s.extraRoots.map((r) => `${r.kind}=${r.path}`).join('、') : '（无）'),
          `忽略（${s.ignore.length}）：${s.ignore.join('、') || '（无）'}`,
          `配置文件：${s.configFile}`,
          '新增根：rules_sources op=add-root kind=<类型> path=<目录>；忽略：op=ignore pattern=<子串>',
        ].join('\n')
      }
      if (op === 'add-root') {
        const kind = String(args.kind ?? 'custom')
        const p = String(args.path ?? '').trim()
        if (!p) return '缺少 path'
        const roots = addRoot(kind, p)
        return `已加入自定义根 ${kind}=${path.resolve(p)}（当前 ${roots.length} 个）。用 op=check 看新来源。`
      }
      if (op === 'ignore') {
        const pat = String(args.pattern ?? '').trim()
        if (!pat) return '缺少 pattern（子串匹配 id 或路径）'
        const ig = addIgnore(pat)
        return `已忽略包含「${pat}」的来源（当前 ${ig.length} 条忽略规则）。`
      }
      if (op === 'list') {
        const all = discoverSources({ force: true })
        const ledger = loadLedger()
        return [`来源 ${all.length} 个（台账 ${Object.keys(ledger.sources || {}).length} 条）：`, ...all.map((s) => `- [${s.kind}] ${s.name}${ledger.sources?.[s.id] ? (ledger.sources[s.id].status === 'harvested' ? ' · 已采集' : ledger.sources[s.id].status === 'stale' ? ' · 已失效' : ' · 待采集') : ' · 未登记'}`)].join('\n')
      }
      if (op === 'record') {
        const only = String(args.only ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const harvested = only.length ? only : discoverSources().map((s) => s.id)
        const r = recordSources({ harvested, note: String(args.note ?? '') })
        return `已登记 ${r.recorded} 个来源，其中标记已采集 ${r.harvested} 个。台账：${SOURCES_FILE}`
      }
      if (op === 'plan') {
        const p = harvestPlan()
        if (!p.new.length && !p.changed.length && !p.removed.length) return `✅ 没有未采集的来源（共 ${p.total} 个，全部已登记且未变化）`
        const lines = [`来源闸口：共 ${p.total} 个来源`]
        if (p.new.length) lines.push('', `## 新来源 ${p.new.length} 个（新学/新装的技能，规则库里还没有它们）`, ...p.new.map((s) => `- [${s.kind}] ${s.name} → ${s.path}`))
        if (p.changed.length) lines.push('', `## 变化 ${p.changed.length} 个（技能更新过，已入库的准则可能需要复核）`, ...p.changed.map((s) => `- [${s.kind}] ${s.name}（上次采集 ${s.harvestedAt || '未采集'}）`))
        if (p.removed.length) lines.push('', `## 来源消失 ${p.removed.length} 个（技能被删，规则可考虑标记 deprecated）`, ...p.removed.map((s) => `- [${s.kind}] ${s.name}`))
        lines.push('', '采集：' + p.suggested)
        lines.push('采集完成后：rules_sources op=record（把来源记为已登记/已采集）')
        return lines.join('\n')
      }
      const parts = [`来源闸口：共 ${gate.total} 个来源 · 未登记 ${gate.new.length} · 有变化 ${gate.changed.length} · 已消失 ${gate.removed.length}`]
      if (gate.new.length) parts.push('新来源：' + gate.new.slice(0, 12).map((s) => s.name).join('、') + (gate.new.length > 12 ? ' …' : ''))
      if (gate.changed.length) parts.push('变化：' + gate.changed.slice(0, 12).map((s) => s.name).join('、'))
      if (gate.removed.length) parts.push('消失：' + gate.removed.slice(0, 12).map((s) => s.name).join('、'))
      parts.push(gate.new.length || gate.changed.length ? '用 op=plan 看采集计划' : '✅ 来源与台账一致')
      return parts.join('\n')
    },
  }),
  vTool({
    name: 'rules_export',
    description: '导出规则：markdown（完整版，名称+key+值）或 table（完整表格）。',
    parameters: { format: { type: 'string', description: 'markdown | table，默认 markdown' } },
    execute: async (args) => {
      const fmt = String(args.format ?? 'markdown')
      const text = fmt === 'table' ? renderMarkdown(loadRules()) : renderDigest(loadRules(), { full: true })
      return text.slice(0, 14000)
    },
  }),
  vTool({
    name: 'rules_report',
    description: '规则健康度报告：总数/active/pending/冲突、按类别、过期（90 天未更新）、从未使用、空缺类别、项目级覆盖、AGENTS 备份数。',
    parameters: { project: { type: 'string', description: '项目目录（可选）：统计该项目的项目级规则' } },
    execute: async (args) => {
      const h = healthReport(loadRules(), { project: String(args.project ?? '') })
      const lines = [
        `生成于 ${h.generatedAt}`,
        `总量 ${h.total} · active ${h.active} · pending ${h.pending} · 冲突 ${h.conflicts}`,
        `按类别：${h.byCategory.map((x) => x.category + '=' + x.count).join(' / ')}`,
        h.project.dir ? `项目级（${h.project.dir}）：${h.project.rules} 条` : '项目级：未指定',
        h.stale.length ? `90 天未更新：${h.stale.join('、')}` : '无过期规则',
        h.coverageGaps.length ? `空缺类别：${h.coverageGaps.join('、')}` : '类别齐备',
        h.topUsed.length ? `最常用：${h.topUsed.map(([k, v]) => k + '(' + v + ')').join('、')}` : '暂无使用记录',
        h.unusedActive.length ? `从未使用（${h.unusedActive.length}）：${h.unusedActive.slice(0, 12).join('、')}${h.unusedActive.length > 12 ? ' …' : ''}` : '全部规则都使用过',
        `AGENTS 备份：${h.agentsBackups} 个`,
      ]
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'skill_import',
    description: '把任意位置下载到的技能变成 DSH 可读：action=inspect 检查结构（有没有 SKILL.md / frontmatter / 文件数），action=install 复制到 ~/.dsh/skills/<名>（缺 SKILL.md 或 frontmatter 时自动生成最小可用版），action=rules 从技能内容提取候选准则草稿（只产草稿，不自动入库）。用户说「我从别处下了一个技能/技能包在某个路径」时用它。',
    parameters: {
      path: { type: 'string', description: '技能目录、或含单个技能子目录的父目录、或 .zip/.tar.gz 文件路径' },
      action: { type: 'string', description: 'inspect（默认）| install | rules' },
      name: { type: 'string', description: '安装后的目录名（默认取 frontmatter.name 或原目录名）' },
      overwrite: { type: 'boolean', description: '已存在同名技能时是否覆盖，默认 false' },
      extractRules: { type: 'boolean', description: 'install 时顺带提取候选准则，默认 true' },
    },
    execute: async (args) => {
      const p = String(args.path ?? '').trim()
      if (!p) return '缺少 path（技能目录 / zip 路径）'
      const action = String(args.action ?? 'inspect')
      if (action === 'inspect' || action === 'rules') {
        const src = action === 'rules' ? p : p
        let info
        try { info = inspectSkill(src) } catch (e) { return '检查失败：' + String(e?.message ?? e) }
        if (action === 'rules') {
          const drafts = draftRulesFromSkill(info.root)
          return drafts.length
            ? [`从 ${info.name} 提取到 ${drafts.length} 条候选准则（草稿，未入库）：`, ...drafts.map((d) => `- ${d.key}｜${d.title} → ${d.value.slice(0, 100)}`)].join('\n')
            : '这个技能的正文里没有提取到可结构化的准则（含命令/数值/路径的条目），可以人工补充。'
        }
        return [
          `技能：${info.name}（${info.fileCount} 个文件）`,
          `目录：${info.root}${info.nested ? '（在父目录里找到唯一技能子目录）' : ''}`,
          `SKILL.md：${info.hasSkillMd ? '有' : '缺（安装时会生成）'}`,
          info.description ? `描述：${info.description}` : '',
          info.multiple ? `⚠ 父目录下有多个技能：${info.multiple.join('、')}，请指定其中一个` : '',
          ...info.warnings.map((w) => '· ' + w),
          '',
          `下一步：skill_import { path: "${info.root}", action: "install" }`,
        ].filter(Boolean).join('\n')
      }
      // install
      let out
      try { out = installSkill(p, { name: String(args.name ?? ''), overwrite: Boolean(args.overwrite) }) }
      catch (e) { return '安装失败：' + String(e?.message ?? e) }
      try { recordSources({ note: 'skill_import: ' + out.name }) } catch {}
      const drafts = args.extractRules === false ? [] : draftRulesFromSkill(out.installed)
      return [
        `✅ 已安装技能：${out.name} → ${out.installed}`,
        out.skillMdFixed ? '（SKILL.md 已自动补全 frontmatter/描述）' : '',
        out.warnings.length ? '注意：' + out.warnings.join('；') : '',
        drafts.length ? `\n从技能提取到 ${drafts.length} 条候选准则（只是草稿）：\n` + drafts.map((d) => `- ${d.key}｜${d.title} → ${d.value.slice(0, 100)}`).join('\n') + '\n确认要入库的用 rules_set 保存（status 建议 pending）' : '',
        '',
        'DSH 下次扫描技能目录时就能加载它（重启 DSH 或新会话最稳）。',
      ].filter(Boolean).join('\n')
    },
  }),
  vTool({
    name: 'rules_draft',
    description: '把用户一句话描述变成结构化准则草稿（key/title/value/category/coverage）：save=false（默认）只返回草稿供确认；save=true 时以 pending 状态入库并同步 AGENTS。用于"帮不会写规则的人写规则"。',
    parameters: {
      text: { type: 'string', description: '用户原话，例如「以后下载模型统一放 D:/models，先用便携版」' },
      save: { type: 'boolean', description: 'true 时直接入库（status=pending），默认 false 只预览' },
      category: { type: 'string', description: '可选：覆盖类别（paths/install/tools/style/safety/workflow/model/skill/imported）' },
      coverage: { type: 'string', description: '可选：default（常驻）或 local（局部）' },
      appliesTo: { type: 'string', description: 'coverage=local 时的任务域，逗号分隔（ppt/paper/coding/blender…）' },
    },
    execute: async (args) => {
      const text = String(args.text ?? '').trim()
      if (!text) return '缺少 text（用户想表达的准则内容）'
      let d
      try { d = draftRuleFromText(text) } catch (e) { return '起草失败：' + String(e?.message ?? e) }
      if (args.category) d.category = String(args.category)
      if (args.category) d.key = d.category + '.' + String(d.key).split('.').slice(1).join('.')
      if (args.coverage === 'local') { d.coverage = 'local'; d.appliesTo = String(args.appliesTo ?? '').split(',').map((s) => s.trim()).filter(Boolean) }
      else if (args.coverage === 'default') d.coverage = 'default'
      if (!args.save) {
        return [
          '准则草稿（尚未保存）：',
          `- 名称：${d.title}`,
          `- 标识：${d.key}`,
          `- 类别：${d.category}`,
          `- 内容：${d.value}`,
          `- 状态：${d.status}`,
          '',
          '确认无误：rules_draft { text: "...", save: true }，或直接 rules_set 保存（可改 title/value/category/coverage）。',
        ].join('\n')
      }
      try {
        const saved = upsertRule(d, { sync: true })
        return `✅ 已保存准则：${d.title}（${d.key}，${d.coverage || '自动适用面'}，status=pending）${saved?.synced?.changed ? '；AGENTS.md 已同步' : ''}`
      } catch (e) { return '保存失败：' + String(e?.message ?? e) }
    },
  }),
  vTool({
    name: 'rules_history',
    description: '查看规则改动记录（最新在前）：哪条规则、什么时间、由什么改成什么。可按 key 过滤。用户问"这条规则以前是什么/谁改的/改过什么"时用它。',
    parameters: {
      key: { type: 'string', description: '只看某条规则的 key（可选）' },
      limit: { type: 'number', description: '最多返回几条，默认 20' },
    },
    execute: async (args) => {
      const entries = loadHistory({ key: args.key ? String(args.key) : null, limit: Number(args.limit) || 20 })
      if (!entries.length) return '没有改动记录' + (args.key ? '：' + args.key : '')
      const label = { create: '新增', update: '修改', remove: '删除' }
      const lines = [`共 ${historyCount()} 条记录${args.key ? '（已按 ' + args.key + ' 过滤）' : ''}，以下 ${entries.length} 条：`]
      for (const e of entries) {
        lines.push(`${String(e.at).replace('T', ' ').slice(0, 19)} · ${label[e.action] || e.action} · ${e.title || e.key}（${e.key}）`)
        for (const c of e.changes || []) lines.push(`  - ${c.label}：「${String(c.from).slice(0, 120)}」→「${String(c.to).slice(0, 120)}」`)
      }
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'rules_topology',
    description: '看一条准则属于哪个"完整流程/项目"：返回同来源（不足则同任务域/同类别）的准则，按阶段（环境路径→工具→流程→风格→安全→模型成本→技能）排列的拓扑，含顺序边。用户说"这条规则是哪来的 / 上下游是什么"时用它。',
    parameters: {
      key: { type: 'string', description: '规则 key，例如 paths.downloads' },
    },
    execute: async (args) => {
      const key = String(args.key ?? '').trim()
      if (!key) return '缺少 key'
      const t = buildTopology(loadRules(), key)
      if (!t) return '没找到这条准则：' + key
      const lines = [`流程拓扑：${t.focus.title}（${t.focus.key}）`, `分组依据：${t.basis === 'source' ? '同一来源' : t.basis === 'domain' ? '同一任务域' : '同一类别'} = ${t.basisLabel} · 共 ${t.total} 条`, '']
      for (const st of t.stages) lines.push(`## ${st.label}（${st.items.length}）`, ...st.items.map((it) => `- ${it.current ? '【当前】' : ''}${it.title}（${it.key}）`), '')
      lines.push('顺序（前→后）：' + t.edges.map((e) => `${e.from}→${e.to}`).slice(0, 12).join('；') + (t.edges.length > 12 ? ' …' : ''))
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'rules_rollback',
    description: 'AGENTS.md 回滚：list 列出 dsh-rules 备份；restore 恢复到指定备份（当前文件会先另存）——危险操作，必须先确认。',
    parameters: {
      op: { type: 'string', description: 'list | restore' },
      name: { type: 'string', description: 'op=restore 时的备份文件名（从 list 里取）' },
    },
    execute: async (args) => {
      const op = String(args.op ?? 'list')
      if (op === 'list') {
        const list = listAgentsBackups()
        return list.length ? `备份（${list.length}）：\n` + list.map((x) => '- ' + x).join('\n') : '没有 dsh-rules 备份'
      }
      if (op === 'restore') {
        if (!args.name) return '缺少 name'
        const r = restoreAgentsBackup(String(args.name))
        return `已回滚 AGENTS.md ← ${r.restored}（${r.bytes} bytes；回滚前版本已另存）`
      }
      return '未知 op：' + op
    },
  }),
  vTool({
    name: 'rules_route',
    description: '语义路由：给任务描述，先返回「默认规则」（常驻，任何会话都生效，这里列出与本任务相关的），再返回「局部规则」（只在本任务域生效；命中即成为这次任务的全局约束）。只读建议，不会改规则。',
    parameters: {
      task: { type: 'string', description: '任务描述，如「给领导做份季度汇报材料」「改 Word 导出 PDF」' },
      topK: { type: 'number', description: '每类返回前几条，默认 12' },
    },
    execute: async (args, exec) => {
      const task = String(args.task ?? '').trim()
      if (!task) return '缺少 task'
      const topK = Number(args.topK) > 0 ? Math.floor(Number(args.topK)) : 12
      const r = await routeTaskSemantic(task, { topK })
      const lines = [`任务：${r.task}`, `路由模式：${r.mode}${r.reason ? '（' + r.reason + '）' : ''}`, `领域标签：${r.tags.join('、') || '（无）'}`, `命中任务域：${(r.domains || []).map((d) => `${d}（${domainLabel(d)}）`).join('、') || '（无）'}`, '']
      const defaults = r.defaultRules || []
      const locals = r.localRules || []
      if (defaults.length) {
        lines.push(`## 默认规则（常驻，${defaults.length} 条命中）`)
        for (const x of defaults) lines.push(`- ${x.key}（${x.title}）→ ${String(x.value).slice(0, 90)}`)
      } else {
        const injected = loadRules().filter((x) => x.status === 'active' && (x.coverage || 'default') === 'default').length
        lines.push(`## 默认规则：本任务未命中相关默认规则（${injected} 条常驻默认已注入 AGENTS.md）`)
      }
      lines.push('')
      if (locals.length) {
        lines.push(`## 局部规则（本任务域生效，${locals.length} 条命中）`)
        for (const x of locals) lines.push(`- [${(x.appliesTo || []).join('+')}] ${x.key}（${x.title}）→ ${String(x.value).slice(0, 90)}`)
      } else lines.push('## 局部规则：本任务未命中局部规则（可用 rules_query coverage=local appliesTo=<域> 手动查）')
      const candidates = r.localCandidates || []
      if (candidates.length) {
        lines.push('', `## 未命中任务域的局部候选（低置信，${candidates.length} 条）`)
        lines.push('任务描述里没提到所属域 ≠ 不需要；这些按分数排，自己判断是否采纳：')
        for (const x of candidates) lines.push(`- [${(x.appliesTo || []).join('+') || '未标域'} · ${x.score}] ${x.key} → ${String(x.value).slice(0, 80)}`)
      }
      lines.push('', `> 本次任务「算全局」的规则 = 默认 ${(r.counts || {}).default ?? 0} 条 + 命中局部 ${(r.counts || {}).local ?? 0} 条（共 ${(r.contextKeys || []).length} 条）`)
      const probe = sessionTagFromExec(exec)
      const tag = probe.tag
      const profile = tag ? loadSessionProfile(tag) : null
      if (profile) {
        const sessRules = sessionDefaultRules(tag)
        lines.push('', `## 本对话默认域：${domainLabel(profile.domain)}（仅本会话，${sessRules.length} 条该域规则当默认）`)
        for (const x of sessRules.slice(0, 15)) lines.push(`- ${x.key} → ${String(x.value).slice(0, 80)}`)
      }
      if (!defaults.length && !locals.length && !candidates.length) {
        lines.push('', '（全部候选，按分数）')
        for (const x of r.rules) lines.push(`- [${x.score.toFixed(2)}] ${x.key} → ${String(x.value).slice(0, 90)}`)
      }
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'rules_coverage',
    description: '适用面总览：默认（常驻）vs 局部（按任务域）的条数与域分布；op=summary 汇总，op=domains 列任务域，op=list 按域列出局部规则，op=review 看待复核队列（推断置信不足的规则+建议），op=accept 把高置信建议落定（写回规则并同步 AGENTS），op=stats 看每条规则的适用面来源。',
    parameters: {
      op: { type: 'string', description: 'summary（默认）| domains | list | review | accept | stats' },
      domain: { type: 'string', description: 'op=list 时的任务域，如 ppt / paper / blender；留空列全部' },
      minConfidence: { type: 'number', description: 'op=accept 的最低置信度，默认 0.6（0.9=仅分类表建议，0.6=含关键词推断，0.2=含兜底）' },
    },
    execute: async (args) => {
      const op = String(args.op ?? 'summary')
      const rules = loadRules()
      const counts = coverageCounts(rules)
      const domains = coverageDomains()
      const byDomain = {}
      for (const r of rules) if (r.coverage === 'local') for (const d of r.appliesTo || []) byDomain[d] = (byDomain[d] || 0) + 1
      if (op === 'review') {
        const review = coverageReview(rules)
        if (!review.length) return '✅ 没有待复核的适用面（全部规则有明确来源）'
        return [
          `待复核 ${review.length} 条（推断置信不足，当前按推断值生效）：`,
          ...review.map((x) => `- ${x.key}（${x.title}）→ 建议 ${x.suggestion.coverage}${x.suggestion.appliesTo?.length ? ':' + x.suggestion.appliesTo.join('+') : ''} · 来源 ${x.reason} · 置信 ${x.confidence}`),
          '',
          '确认可用 op=accept（默认只落定置信 ≥0.6 的）；要逐条改就用 rules_set 传 coverage/appliesTo。',
        ].join('\n')
      }
      if (op === 'accept') {
        const minConfidence = Number(args.minConfidence)
        const r = acceptCoverageSuggestions({ minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.6 })
        return r.accepted
          ? `已落定 ${r.accepted} 条：${r.keys.slice(0, 10).join('、')}${r.keys.length > 10 ? ' …' : ''}；剩余待复核 ${r.remaining} 条。AGENTS.md 已重新同步。`
          : `没有达到置信阈值的待复核项（剩余 ${r.remaining} 条需要人工用 rules_set 指定）`
      }
      if (op === 'stats') {
        const bySource = {}
        for (const r of rules) bySource[r.coverageSource || 'unknown'] = (bySource[r.coverageSource || 'unknown'] || 0) + 1
        const conf = {}
        for (const r of rules) { const c = String(r.coverageConfidence ?? '?'); conf[c] = (conf[c] || 0) + 1 }
        return [
          `适用面来源：${Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' / ')}`,
          `置信度分布：${Object.entries(conf).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' / ')}`,
          `待复核：${counts.needsReview} 条（op=review 查看）`,
        ].join('\n')
      }
      if (op === 'domains') {
        const lines = Object.entries(domains).map(([id, label]) => `- ${id}：${label}（${byDomain[id] || 0} 条）`)
        return ['任务域（局部规则按域路由）：', ...lines].join('\n')
      }
      if (op === 'list') {
        const d = String(args.domain ?? '').trim()
        const list = rules.filter((r) => r.coverage === 'local' && (!d || (r.appliesTo || []).includes(d)))
        if (!list.length) return `没有匹配的局部规则（域：${d || '全部'}）`
        return [`局部规则 ${list.length} 条${d ? `（域 ${d}）` : ''}：`, ...list.map((r) => `- [${(r.appliesTo || []).join('+')}] ${r.key}（${r.title || r.key}）→ ${String(r.value).slice(0, 80)}`)].join('\n')
      }
      const lines = [
        `全部 ${rules.length} 条：默认（常驻注入）${counts.default} 条，局部（按任务域）${counts.local} 条`,
        `任务域 ${Object.keys(byDomain).length} 个：` + Object.entries(byDomain).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}=${n}`).join(' / '),
        '规则：默认规则自动写进 AGENTS.md 托管段；局部规则用 rules_route（任务）或 rules_query（coverage=local, appliesTo=域）取。',
      ]
      return lines.join('\n')
    },
  }),
  vTool({
    name: 'rules_read',
    description: '读取准则（供「一键读取规则」用）：默认只返回「未读/已变更」的准则（按上次标记的指纹对比），mode=all 返回全部。首次读取=全量；之后再读只给新增/变更，避免重复读旧规则。读完请调用 rules_mark_read。',
    parameters: {
      mode: { type: 'string', description: 'pending（默认，只读未读/变更）/ all（全量）' },
      includeInactive: { type: 'boolean', description: 'true 时连同 pending/deprecated 一起返回（默认 false）' },
    },
    execute: async (args) => {
      const prog = readProgress()
      const all = loadRules()
      const pool = args.includeInactive ? all : all.filter((r) => r.status === 'active')
      const list = args.mode === 'all' ? pool : pool.filter((r) => prog.unread.some((u) => u.id === r.id))
      const header = args.mode === 'all'
        ? `全量准则 ${list.length} 条（库内 ${all.length} 条；上次读取：${prog.lastReadAt || '从未'}）`
        : `未读/变更准则 ${list.length} 条（库内 ${prog.total} 条；上次读取：${prog.lastReadAt || '从未'}）`
      if (!list.length) return asText(`${header}\n没有需要读取的准则（全部已读）。可直接调用 rules_mark_read 刷新时间戳。`)
      const lines = list.map((r) => [
        `### ${r.key}（${r.title || r.key}）`,
        `- 适用面：${r.coverage || 'default'}${(r.appliesTo || []).length ? '（' + r.appliesTo.join(',') + '）' : ''}`,
        `- 类别/作用域：${r.category}/${r.scope}${r.priority ? ' · p' + r.priority : ''}`,
        `- 来源：${r.source || '-'}${r.updatedAt ? ' · 更新于 ' + r.updatedAt : ''}`,
        `- 内容：${String(r.value).replace(/\n/g, ' ')}`,
        ...(r.explain ? [`- 白话解释：${String(r.explain).replace(/\n/g, ' ')}`] : []),
      ].join('\n'))
      return asText(`${header}\n\n${lines.join('\n\n')}`, undefined)
    },
  }),
  vTool({
    name: 'rules_mark_read',
    description: '标记「准则已读完」：由助手在完成读取后调用，记录时间戳与每条规则的指纹；面板的未读小圈会因此清零。',
    parameters: {
      note: { type: 'string', description: '可选备注，例如「增量读取」' },
    },
    execute: async (args) => {
      const prog = readProgress()
      const now = new Date().toISOString()
      const all = loadRules()
      saveReadState({
        lastReadAt: now,
        lastReadCount: all.filter((r) => r.status === 'active').length,
        fingerprints: Object.fromEntries(all.map((r) => [r.key, ruleStamp(r)])),
        note: String(args.note ?? ''),
      })
      return asText(`已标记读取：共 ${all.filter((r) => r.status === 'active').length} 条（本次新增/变更 ${prog.unread.length} 条），时间 ${now}`)
    },
  }),
  vTool({
    name: 'rules_restore',
    description: '读取规则/恢复全部可用准则：扫描历史快照与归档（~/.dsh/rules.* 快照目录、rules/backups、rules/archive），把库里缺失的规则补回来；已存在的规则跳过、不覆盖用户改动。dryRun=true 只预览。',
    parameters: {
      source: { type: 'string', description: '可选：指定快照文件（rules.jsonl）路径；省略则自动选条数最多的历史快照' },
      dryRun: { type: 'boolean', description: 'true 时只预览会恢复多少条，不写入' },
    },
    execute: async (args) => {
      const sources = discoverRuleArchives()
      if (!sources.length) return '没有找到历史快照/归档（~/.dsh/rules.*、rules/backups、rules/archive 都没有）。'
      const pick = args.source ? { file: String(args.source) } : sources[0]
      try {
        const r = restoreFromSource(pick.file, { dryRun: args.dryRun === true })
        const now = loadRules().length
        const head = r.dryRun
          ? `预览（未写入）：快照 ${r.incoming} 条 → 将新增 ${r.added} 条，跳过已存在 ${r.skipped} 条；当前库 ${now} 条`
          : `已恢复：快照 ${r.incoming} 条 → 新增 ${r.added} 条，跳过已存在 ${r.skipped} 条；当前库 ${now} 条${r.schemesRestored ? '（分类方案也已恢复）' : ''}`
        return asText(head + '\n来源：' + r.file + '\n其它可用快照：' + sources.slice(1, 5).map((s) => `${s.label}(${s.count})`).join(' / '))
      } catch (e) { return '恢复失败：' + String(e?.message ?? e) }
    },
  }),
  vTool({
    name: 'rules_collect',
    description: '读取规则：扫描系统里现存的准则来源（~/.dsh/AGENTS.md 手写段、EXPERIENCE.md、项目 AGENTS.md、用户技能 ~/.dsh/skills、~/.agents/skills、插件自带技能（profile node_modules/*/skills）、style-packs），把其中未被收录的准则记录进统一准则库；长条目按分号拆分、关键词加权分类、按内容去重（近重复相似度 ≥0.86 也跳过）。dryRun=true 只预览。',
    parameters: {
      dryRun: { type: 'boolean', description: 'true 时只预览会收录多少条，不写入' },
      resetSuppressed: { type: 'boolean', description: 'true 时清空「删除抑制清单」，让以前手动删掉的收集规则也能重新收录' },
    },
    execute: async (args) => {
      const r = collectRules({ dryRun: args.dryRun === true, resetSuppressed: args.resetSuppressed === true })
      const now = loadRules().length
      const src = Object.entries(r.perSource).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join('、')
      return asText(`${r.dryRun ? '预览（未写入）' : '已读取'}：候选 ${r.candidates} 条 → 新收录 ${r.added} 条，跳过重复 ${r.skipped} 条（其中已抑制删除项 ${r.suppressedSkipped || 0}）；当前库 ${now} 条\n来源：${src || '无'}`)
    },
  }),
  vTool({
    name: 'rules_issues',
    description: '问题台账：扫描准则库里的问题并按「归属」分组（待复核 / 冲突 / 同标题多条 / 重复内容 / 来源失效 / 抑制清单 / 字段异常 / 适用面），每条附处理建议。用户问「有哪些问题 / 检查一下准则库」时用它；不要自动改库。',
    parameters: {
      lines: { type: 'number', description: '最多列出多少组（默认 8）' },
    },
    execute: async (args) => {
      const i = scanIssues()
      return issuesSummary(i, { lines: Number(args.lines) || 8 })
    },
  }),
  vTool({
    name: 'rules_groups',
    description: '分类方案/分类树管理：list 列方案；show 看树；scheme-* 管方案；node-add/rename/delete/move 管节点（任意层级）；move 把规则移到某节点（只移动不复制，node 留空=未分类）。',
    parameters: {
      op: { type: 'string', description: 'list | show | scheme-create | scheme-rename | scheme-delete | scheme-reset | node-add | node-rename | node-delete | node-move | move' },
      scheme: { type: 'string', description: '方案 id（默认 default）' },
      node: { type: 'string', description: '节点 id（show / node-* / move 的源）' },
      parent: { type: 'string', description: '父节点 id（node-add / node-move；留空=顶级）' },
      target: { type: 'string', description: 'op=move 的目标节点 id；留空或 __unassigned__=未分类' },
      title: { type: 'string', description: '方案或节点名称' },
      desc: { type: 'string', description: '说明' },
      key: { type: 'string', description: 'op=move 时的规则 key' },
    },
    execute: async (args) => {
      const rules = loadRules()
      const op = String(args.op ?? 'list')
      const schemeId = String(args.scheme ?? 'default')
      const node = String(args.node ?? '')
      const parent = args.parent === undefined || args.parent === '' ? null : String(args.parent)
      const target = args.target === undefined || args.target === '' ? null : String(args.target)
      if (op === 'list') {
        return '分类方案：\n' + listSchemes(rules).map((s) => `- ${s.id} ${s.title}（${s.total} 条，未分类 ${s.unassigned}${s.builtin ? '，内置' : ''}）${s.desc ? ' — ' + s.desc : ''}`).join('\n')
      }
      if (op === 'show') {
        const view = schemeView(getScheme(schemeId), rules)
        const lines = [`${view.title}（${view.id}）${view.builtin ? '［内置］' : ''} 合计 ${view.total} 条，未分类 ${view.unassigned}`]
        const pr = (nodes, depth = 0) => { for (const n of nodes) { lines.push('  '.repeat(depth) + `- ${n.title}（${n.own}/${n.total}）[${n.id}]`); pr(n.children, depth + 1) } }
        pr(view.roots)
        return lines.join('\n')
      }
      if (op === 'scheme-create') { const s = createScheme({ title: String(args.title ?? ''), desc: String(args.desc ?? '') }); return `已建方案：${s.id} ${s.title}` }
      if (op === 'scheme-rename') { const s = renameScheme(schemeId, { title: args.title, desc: args.desc }); return '已更新方案：' + s.title }
      if (op === 'scheme-delete') return '已删除方案：' + deleteScheme(schemeId).deleted
      if (op === 'scheme-reset') { const s = resetDefaultScheme(); return '已恢复内置方案结构（用户方案保留）：' + s.id }
      if (op === 'node-add') { const n = addNode({ schemeId, parentId: parent, title: String(args.title ?? ''), desc: String(args.desc ?? '') }); return `已加节点：${n.id} ${n.title}` }
      if (op === 'node-rename') { renameNode({ schemeId, nodeId: node, title: args.title, desc: args.desc }); return '已重命名节点：' + node }
      if (op === 'node-delete') return '已删除节点：' + deleteNode({ schemeId, nodeId: node }).removed.join(',')
      if (op === 'node-move') { moveNode({ schemeId, nodeId: node, parentId: parent }); return `已移动节点 ${node} → ${parent || '顶级'}` }
      if (op === 'move') { moveRule({ schemeId, key: String(args.key ?? ''), nodeId: target === '__unassigned__' ? null : target }); return `已移动规则 ${args.key} → ${target || '未分类'}` }
      return '未知 op：' + op
    },
  }),
]

function sendJson(res, code, body) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {}
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function registerRoutes(hostCtx, deps = {}) {
  const web = hostCtx?.webServer
  if (!web || typeof web.register !== 'function') return
  const routes = [
    {
      kind: 'exact', path: '/dsh-rules/list',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const rules = loadRules()
        const schemes = listSchemes(rules)
        const schemeId = String(url.searchParams.get('scheme') ?? '') || schemes[0]?.id
        const scheme = getScheme(schemeId)
        const assign = computeAssignments(scheme, rules)
        sendJson(res, 200, {
          ok: true,
          schemeId: scheme.id,
          schemes,
          tree: schemeView(scheme, rules),
          coverage: coverageCounts(rules),
          domains: coverageDomains(),
          undoAvailable: hasUndo(),
          pluginVersion: PLUGIN_VERSION,
          features: { undo: true, reorder: true, coverage: true, sources: true, assistant: true, skillImport: true },
          sources: (() => { const g = checkSources({ force: false }); return { total: g.total, new: g.new.map((s) => ({ id: s.id, kind: s.kind, name: s.name })), changed: g.changed.map((s) => ({ id: s.id, kind: s.kind, name: s.name })), removed: g.removed.length } })(),
          rules: rules.map((r) => ({ ...r, tags: tagsOf(r), nodeId: assign.get(r.key) ?? null })),
        })
      },
    },
    { kind: 'exact', path: '/dsh-rules/audit', handler: (req, res) => sendJson(res, 200, { ok: true, audit: auditRules(loadRules()) }) },
    {
      kind: 'exact', path: '/dsh-rules/coverage',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const rules = loadRules()
        const counts = coverageCounts(rules)
        const byDomain = {}
        for (const r of rules) if (r.coverage === 'local') for (const d of r.appliesTo || []) byDomain[d] = (byDomain[d] || 0) + 1
        const domain = String(url.searchParams.get('domain') ?? '')
        sendJson(res, 200, {
          ok: true,
          counts,
          domains: coverageDomains(),
          byDomain,
          local: rules.filter((r) => r.coverage === 'local' && (!domain || (r.appliesTo || []).includes(domain))).map((r) => ({ key: r.key, title: r.title || r.key, appliesTo: r.appliesTo || [], category: r.category })),
        })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/route',
      handler: async (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const task = String(url.searchParams.get('task') ?? '')
        if (!task) return sendJson(res, 400, { ok: false, error: '缺少 task' })
        sendJson(res, 200, { ok: true, route: await routeTaskSemantic(task, { topK: 12 }) })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/tree',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const url = new URL(String(req.url ?? '/'), 'http://localhost')
            const rules = loadRules()
            const schemes = listSchemes(rules)
            const scheme = getScheme(String(url.searchParams.get('scheme') ?? '') || schemes[0]?.id)
            return sendJson(res, 200, { ok: true, schemes, scheme: schemeView(scheme, rules), undoAvailable: hasUndo() })
          }
          const body = await readBody(req)
          const action = String(body.action ?? '')
          const schemeId = String(body.schemeId ?? body.scheme ?? 'default')
          const nodeId = body.nodeId === undefined ? '' : String(body.nodeId)
          const parentId = body.parentId === undefined || body.parentId === '' || body.parentId === null ? null : String(body.parentId)
          const targetId = body.targetId === undefined || body.targetId === '' || body.targetId === null || body.targetId === '__unassigned__' ? null : String(body.targetId)
          const index = body.index === undefined || body.index === null || body.index === '' ? null : Number(body.index)
          let result = {}
          if (action === 'undo') result = { undo: undoLast() }
          else if (action === 'scheme-create') result = { scheme: createScheme({ title: String(body.title ?? ''), desc: String(body.desc ?? '') }) }
          else if (action === 'scheme-rename') result = { scheme: renameScheme(schemeId, { title: body.title, desc: body.desc }) }
          else if (action === 'scheme-delete') result = deleteScheme(schemeId)
          else if (action === 'scheme-reset') result = { scheme: resetDefaultScheme() }
          else if (action === 'node-add') result = { node: addNode({ schemeId, parentId, title: String(body.title ?? ''), desc: String(body.desc ?? ''), select: body.select }) }
          else if (action === 'node-rename') result = renameNode({ schemeId, nodeId, title: body.title, desc: body.desc })
          else if (action === 'node-delete') result = deleteNode({ schemeId, nodeId })
          else if (action === 'node-move') result = moveNode({ schemeId, nodeId, parentId, index })
          else if (action === 'rule-move') result = moveRule({ schemeId, key: String(body.key ?? ''), nodeId: targetId, index })
          else return sendJson(res, 400, { ok: false, error: '未知 action：' + action })
          const rules = loadRules()
          return sendJson(res, 200, { ok: true, result, schemes: listSchemes(rules), scheme: schemeView(getScheme(schemeId), rules), undoAvailable: hasUndo() })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/set',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        try {
          const r = upsertRule(body, { sync: false })
          const sync = body?.sync === false ? null : syncAgents({ silent: true })
          sendJson(res, 200, { ok: true, rule: r.rule, synced: sync })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/sync',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        sendJson(res, 200, syncAgents({ silent: true }))
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/remove',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        try {
          const r = removeRule(String(body.key ?? ''), String(body.scope ?? 'global'))
          sendJson(res, 200, r)
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/report',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        sendJson(res, 200, { ok: true, report: healthReport(loadRules(), { project: String(url.searchParams.get('project') ?? '') }) })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/sources',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const url = new URL(String(req.url ?? '/'), 'http://localhost')
            const op = String(url.searchParams.get('op') ?? 'check')
            if (op === 'plan') return sendJson(res, 200, { ok: true, plan: harvestPlan() })
            if (op === 'list') { const all = discoverSources(); return sendJson(res, 200, { ok: true, sources: all, ledger: loadLedger() }) }
            const g = checkSources()
            return sendJson(res, 200, { ok: true, gate: { total: g.total, new: g.new, changed: g.changed, removed: g.removed, unchanged: g.unchanged, ledgerUpdatedAt: g.ledgerUpdatedAt } })
          }
          const body = await readBody(req)
          const r = recordSources({ harvested: Array.isArray(body.harvested) ? body.harvested : discoverSources().map((s) => s.id), note: String(body.note ?? '') })
          sendJson(res, 200, { ok: true, ...r, file: SOURCES_FILE })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/history',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const key = String(url.searchParams.get('key') ?? '') || null
        const limit = Number(url.searchParams.get('limit') ?? 200) || 200
        sendJson(res, 200, { ok: true, total: historyCount(), entries: loadHistory({ key, limit }) })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/session',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const url = new URL(String(req.url ?? '/'), 'http://localhost')
          const tag = String(url.searchParams.get('session') ?? '').trim()
          if (!tag) return sendJson(res, 200, { ok: true, profiles: listSessionProfiles() })
          // 诊断：记录面板实际传来的会话 id（用于核对「面板 sessionId」与「工具 agent.session.id」是否同源）
          try {
            fs.mkdirSync(RULES_DIR, { recursive: true })
            fs.appendFileSync(path.join(RULES_DIR, 'session-seen.log'), JSON.stringify({
              at: new Date().toISOString(),
              session: tag,
              referer: String(req.headers?.referer ?? ''),
              ua: String(req.headers?.['user-agent'] ?? ''),
            }) + '\n', 'utf8')
          } catch {}
          const profile = loadSessionProfile(tag)
          const activeKeys = sessionDefaultRules(tag).map((r) => r.key)
          return sendJson(res, 200, { ok: true, session: tag, profile, pins: (profile && profile.pins) || [], activeKeys })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST only' })
        const body = await readBody(req)
        const op = String(body.op ?? 'list')
        try {
          if (op === 'list') return sendJson(res, 200, { ok: true, profiles: listSessionProfiles() })
          const tag = String(body.session ?? '').trim()
          if (!tag) return sendJson(res, 400, { ok: false, error: '缺少 session（会话 id）' })
          if (op === 'clear') return sendJson(res, 200, { ok: true, cleared: clearSessionProfile(tag) })
          if (op === 'set') {
            const profile = setSessionProfile(tag, { domain: String(body.domain ?? ''), label: body.label, ttlDays: body.ttlDays })
            return sendJson(res, 200, { ok: true, profile, rules: sessionDefaultRules(tag).length })
          }
          if (op === 'pin' || op === 'unpin') {
            const keys = (Array.isArray(body.keys) ? body.keys : String(body.keys ?? '').split(','))
              .map((k) => String(k || '').trim()).filter(Boolean)
            if (!keys.length) return sendJson(res, 400, { ok: false, error: '缺少 keys' })
            const pins = pinSessionRules(tag, keys, op === 'pin')
            return sendJson(res, 200, { ok: true, pins, rules: sessionDefaultRules(tag).length })
          }
          if (op === 'show') return sendJson(res, 200, { ok: true, profile: loadSessionProfile(tag), rules: sessionDefaultRules(tag).length })
          return sendJson(res, 400, { ok: false, error: '未知 op：' + op })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e?.message ?? String(e) })
        }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/topology',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const key = String(url.searchParams.get('key') ?? '')
        if (!key) return sendJson(res, 400, { ok: false, error: '缺少 key' })
        sendJson(res, 200, { ok: true, topology: buildTopology(loadRules(), key) })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/read-state',
      handler: (req, res) => {
        const p = readProgress()
        sendJson(res, 200, {
          ok: true,
          lastReadAt: p.lastReadAt,
          lastReadCount: p.lastReadCount,
          total: p.total,
          unread: p.unread.length,
          unreadKeys: p.unread.map((r) => r.key),
        })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/read',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          if (assistantBusy()) return sendJson(res, 409, { ok: false, error: '助手正在处理上一条消息，请稍候' })
          const p = readProgress()
          // 任务文本保持简短：职责说明在 ~/.dsh/rules/ASSISTANT.md 与助手工作区 AGENTS.md，
          // 不再往用户消息里拼大段约束。
          const prompt = `【读取规则任务】依次调用 rules_collect（增量收录）→ rules_mark_read → rules_issues，然后一行汇报「读取完成：新收录 X 条，当前共 Y 条」，有问题就另起一行「问题 N 个：前 3 类」。当前库 ${p.total} 条，上次读取 ${p.lastReadAt || '从未'}。`
          const r = await sendToAssistant(deps.sessionController, prompt, { cwd: deps.cwd || process.cwd(), sessions: deps.sessions })
          return sendJson(res, 200, { ok: true, unread: p.unread.length, total: p.total, ...r })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/debug-session-controller',
      handler: (req, res) => {
        let ctrl = null
        try { ctrl = deps.sessionController } catch {}
        let methods = []
        try {
          const proto = ctrl ? Object.getPrototypeOf(ctrl) : null
          methods = proto ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor') : []
        } catch {}
        let ownKeys = []
        try { ownKeys = ctrl ? Object.keys(ctrl) : [] } catch {}
        let sess = null
        try { sess = deps.sessions } catch {}
        return sendJson(res, 200, {
          ok: true,
          available: Boolean(ctrl),
          type: ctrl ? (ctrl.constructor && ctrl.constructor.name) || typeof ctrl : null,
          methods,
          ownKeys,
          sessionsAvailable: Boolean(sess),
          sessionsCreate: Boolean(sess && typeof sess.create === 'function'),
        })
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/assistant',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const chat = getAssistantChat({ limit: 80 })
            return sendJson(res, 200, { ok: true, ...chat, busy: assistantBusy() })
          }
          const body = await readBody(req)
          if (body.action === 'reset') { resetAssistant(); return sendJson(res, 200, { ok: true, reset: true }) }
          // 用户发什么就是什么；新会话只在开头加一行「读职责文件」的指引（约 30 字），
          // 详细职责在 ~/.dsh/rules/ASSISTANT.md，不再拼大段约束。
          const targetSession = String(body.session ?? '').trim()
          let content = String(body.message ?? '').trim()
          const chat0 = getAssistantChat({ limit: 1 })
          const isFirst = !chat0.exists || !(chat0.messages || []).length
          if (isFirst) content = '（先读 ~/.dsh/rules/ASSISTANT.md 了解职责）\n' + content
          const r = await sendToAssistant(deps.sessionController, content, {
            cwd: deps.cwd || process.cwd(),
            sessionId: String(body.sessionId ?? ''),
            targetSession,
            sessions: deps.sessions,
          })
          sendJson(res, 200, { ok: true, ...r })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/skill-import',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          const body = await readBody(req)
          const info = inspectSkill(String(body.path ?? ''))
          if (body.action === 'inspect') return sendJson(res, 200, { ok: true, inspect: info })
          const out = installSkill(String(body.path ?? ''), { name: String(body.name ?? ''), overwrite: Boolean(body.overwrite) })
          try { recordSources({ note: 'skill_import: ' + out.name }) } catch {}
          const drafts = draftRulesFromSkill(out.installed)
          sendJson(res, 200, { ok: true, installed: out, drafts })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/rule-draft',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          const body = await readBody(req)
          const draft = draftRuleFromText(String(body.text ?? ''))
          if (body.category) { draft.category = String(body.category); draft.key = draft.category + '.' + String(draft.key).split('.').slice(1).join('.') }
          if (body.save) { upsertRule(draft, { sync: true }); return sendJson(res, 200, { ok: true, draft, saved: true }) }
          sendJson(res, 200, { ok: true, draft })
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/backups',
      handler: (req, res) => sendJson(res, 200, { ok: true, backups: listAgentsBackups() }),
    },
    {
      kind: 'exact', path: '/dsh-rules/rollback',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        try { sendJson(res, 200, { ok: true, ...restoreAgentsBackup(String(body.name ?? '')) }) }
        catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/project',
      handler: (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://localhost')
        const dir = String(url.searchParams.get('dir') ?? '')
        sendJson(res, 200, { ok: true, dir, file: PROJECT_FILE, rules: dir ? loadProjectRules(dir) : [] })
      },
    },
    {
      // 管理页/面板共用的模糊搜索模块（把 ESM 转成挂在 window.DshRulesSearch 的经典脚本）
      kind: 'exact', path: '/dsh-rules/search.js',
      handler: (req, res) => {
        try {
          const raw = fs.readFileSync(fileURLToPath(new URL('./search.js', import.meta.url)), 'utf8')
          const classic = raw
            .replace(/^export\s+function\s+/gm, 'function ')
            .replace(/^export\s+/gm, '')
          const body = classic + '\nwindow.DshRulesSearch = { fuzzyHit: fuzzyHit, fuzzyScore: fuzzyScore, editDistance: editDistance, isSubsequence: isSubsequence };\n'
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (e) { sendJson(res, 500, { ok: false, error: '搜索模块读取失败：' + String(e?.message ?? e) }) }
      },
    },
    {
      kind: 'exact', path: '/dsh-rules/ui',
      handler: (req, res) => {
        try {
          const html = fs.readFileSync(UI_FILE, 'utf8')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        } catch (e) { sendJson(res, 500, { ok: false, error: 'UI 文件读取失败：' + String(e?.message ?? e) }) }
      },
    },
  ]
  for (const route of routes) {
    try { hostCtx.effect ? hostCtx.effect(() => web.register(route)) : web.register(route) } catch {}
  }
}

export function apply(ctx, config = {}) {
  try {
    loadRules()
    syncAgents({ silent: true })
    // 来源闸口：启动时登记/比对一次，新技能/新配置会在日志与 UI 里提示（不自动采集）
    try {
      for (const r of sourceRoots()) if (r.kind === 'runtime-skill') addRoot('runtime-skill', r.dir)  // 自动记住本机 runtime 技能根，跨 CLI/宿主一致
    } catch {}
    const gate = checkSources()
    if (gate.new.length || gate.changed.length) {
      try { ctx?.logger?.info?.(`[dsh-rules] 来源闸口：${gate.new.length} 个新来源、${gate.changed.length} 个变化未采集（rules_sources op=plan）`) } catch {}
    }
  } catch (e) {
    try { ctx?.logger?.warn?.('[dsh-rules] 初始化失败：' + (e?.message ?? e)) } catch {}
  }
  for (const t of TOOLS) {
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => ctx.tools.register(t))
      else ctx.tools.register(t)
    } catch (e) {
      try { ctx?.logger?.warn?.('[dsh-rules] 注册工具失败：' + (e?.message ?? e)) } catch {}
    }
  }
  // 宿主服务：插件 ctx 只暴露 inject 声明的服务，所以单独注入 sessionController（惰性，拿不到也不影响其它功能）
  let injectedSessionController = null
  let injectedSessions = null
  try {
    ctx.inject?.(['sessionController', 'sessions'], (hostCtx) => {
      try {
        injectedSessionController = hostCtx.sessionController || (typeof hostCtx.get === 'function' ? hostCtx.get('sessionController') : null)
      } catch {}
      try {
        injectedSessions = hostCtx.sessions || (typeof hostCtx.get === 'function' ? hostCtx.get('sessions') : null)
      } catch {}
      try { ctx?.logger?.info?.('[dsh-rules] sessionController ' + (injectedSessionController ? '已就绪' : '不可用') + ' / sessions ' + (injectedSessions ? '已就绪' : '不可用')) } catch {}
    })
  } catch {}
  try {
    ctx.inject?.(['webServer'], (hostCtx) => {
      // 注册阶段不能直接读 ctx.sessionController：Cordis 服务可能还没就绪（getter 抛错），
      // 一旦抛出，整个回调中断 → 所有路由都挂不上（表现就是面板 404 白屏）。
      // 所以这里传惰性 getter，等到真正收到 assistant 请求时再取。
      const deps = {
        get sessionController() {
          try {
            return injectedSessionController || ctx.sessionController || (typeof ctx.get === 'function' ? ctx.get('sessionController') : null)
          } catch { return null }
        },
        get sessions() {
          try {
            return injectedSessions || ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : null)
          } catch { return null }
        },
        cwd: process.cwd(),
      }
      try { registerRoutes(hostCtx, deps) } catch (e) {
        try { ctx?.logger?.warn?.('[dsh-rules] 注册路由失败：' + (e?.message ?? e)) } catch {}
      }
    })
  } catch {}
}
