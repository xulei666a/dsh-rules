/**
 * dsh-rules · 存储与解析层（v0）
 *
 * 唯一真源：~/.dsh/rules/rules.jsonl（每行一条规则）
 * 规则形状：
 *   { id, scope, category, key, value, priority, source, status, updatedAt }
 *   - id = `${scope}::${key}`（同一 key 在不同 scope 可并存，解析时按优先级取胜）
 *   - scope: global | user | project:<path>
 *   - category: paths | install | tools | style | safety | workflow | model | notify | skill | imported
 *   - status: active | pending | deprecated
 *   - priority: 数字，越大越优先；缺省 global=100 / user=200 / project=300
 * 生效规则 = 按 (priority, scopeRank) 排序后同 key 取第一条。
 * 对外出口：AGENTS.md 托管段（always-on）+ 工具/CLI 查询。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const DSH_DIR = path.join(HOME, '.dsh')
export const RULES_DIR = path.join(DSH_DIR, 'rules')
export const STORE_FILE = path.join(RULES_DIR, 'rules.jsonl')
export const HISTORY_FILE = path.join(RULES_DIR, 'history.jsonl')
export const AGENTS_FILE = path.join(DSH_DIR, 'AGENTS.md')
export const DEFAULTS_FILE = fileURLToPath(new URL('../rules/defaults.json', import.meta.url))
export const COVERAGE_FILE = path.join(RULES_DIR, 'coverage-map.json')
import { inferCoverage } from './coverage.js'

export const CATEGORIES = ['paths', 'install', 'tools', 'style', 'safety', 'workflow', 'model', 'notify', 'skill', 'imported']
const SCOPE_RANK = { global: 1, user: 2, default: 0 }
const scopeRank = (scope) => {
  const s = String(scope)
  if (s.startsWith('session')) return 4   // 会话级：只对该会话生效，优先级最高
  if (s.startsWith('project')) return 3   // 项目级：覆盖全局
  return SCOPE_RANK[s] ?? 1
}
const MARK_BEGIN = '<!-- dsh-rules:begin 自动生成段，手改会被覆盖；改规则请用 dsh-rules 工具/CLI -->'
const MARK_END = '<!-- dsh-rules:end -->'
const nowISO = () => new Date().toISOString()

// 人类可读名称：管理界面主列表只显示这个；key/scope/source 收进「详情」（点开才看）
const LABELS = {
  'paths.downloads': '下载默认目录',
  'paths.install': '软件安装目录',
  'paths.deliverables': '交付物目录',
  'paths.scratch': '临时文件目录',
  'paths.models': '模型文件目录',
  'install.prefer_portable': '优先便携版',
  'install.user_scope': '安装到当前用户',
  'install.github_proxy': 'GitHub 下载代理',
  'install.verify_checksum': '下载后校验文件',
  'tools.ppt': '做 PPT 用哪个工具',
  'tools.paper': '写论文用哪个工具',
  'tools.diagram': '画图表用哪个工具',
  'tools.search': '检索资料用哪个工具',
  'style.ppt': 'PPT 默认风格',
  'style.paper': '论文默认风格',
  'style.report': '报告默认风格',
  'safety.delete_confirm': '删除/覆盖前先确认',
  'safety.no_global_npm': '禁止全局安装 npm 包',
  'safety.approval_first': '重要操作先确认',
  'workflow.deliverables_dir': '工作交付目录',
  'workflow.report_style': '汇报风格',
  'workflow.verify_before_claim': '先证据后结论',
  'model.offpeak_only_autonomy': '自主上网只走低谷时段',
  'skill.auto_install_min_score': '技能自动安装的最低分',
  'skill.daily_budget': '每天技能学习配额',
  'agent.reply_max_chars': '评论回复字数上限',
  'agent.ack_before_work': '派活先确认再动手',
}
const CATEGORY_LABELS = {
  paths: '路径习惯', install: '安装与下载', tools: '工具选择', style: '产出风格',
  safety: '安全红线', workflow: '工作方式', model: '模型与预算', notify: '通知',
  skill: '技能学习', imported: '其他 / 导入',
}
export const categoryLabel = (c) => CATEGORY_LABELS[c] ?? c
export function labelOf(key) {
  const k = String(key ?? '')
  if (LABELS[k]) return LABELS[k]
  const m = k.match(/^paths\.convention_(\d+)$/)
  if (m) return `路径约定 ${m[1]}`
  const tail = k.split('.').slice(-1)[0].replace(/[_-]+/g, ' ')
  const head = k.split('.').slice(0, -1).join(' ')
  return `${head} ${tail}`.trim() || k
}

const ensureDir = () => fs.mkdirSync(RULES_DIR, { recursive: true })
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function readDefaults() {
  try { return JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')) } catch { return [] }
}

/* ---------------- 适用面（coverage）：default 常驻 / local 按任务域路由 ---------------- */
let _covCache = { mtime: 0, data: null }
export function loadCoverageMap() {
  try {
    const st = fs.statSync(COVERAGE_FILE)
    if (_covCache.data && _covCache.mtime === st.mtimeMs) return _covCache.data
    const data = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'))
    _covCache = { mtime: st.mtimeMs, data }
    return data
  } catch { return { version: 1, domains: {}, map: {} } }
}
export function coverageDomains() { return loadCoverageMap().domains || {} }
export function domainLabel(d) { return coverageDomains()[d] || d }
/** 给规则补 coverage/appliesTo/置信度/待复核标记（推断逻辑见 lib/coverage.js） */
export function applyCoverage(rule) {
  const inf = inferCoverage(rule, loadCoverageMap())
  return {
    ...rule,
    coverage: inf.coverage,
    appliesTo: inf.appliesTo,
    coverageSource: inf.coverageSource,
    coverageConfidence: inf.confidence,
    needsReview: inf.needsReview,
  }
}
export const coverageCounts = (rules) => {
  const defaults = rules.filter((r) => r.coverage === 'default').length
  return { default: defaults, local: rules.length - defaults, needsReview: rules.filter((r) => r.needsReview).length }
}
/** 待复核队列：直接看 loadRules 推断出的 needsReview 标记（不重复推断，避免把推断值当显式值） */
export function coverageReview(rules = loadRules()) {
  return rules.filter((r) => r.needsReview).map((r) => ({
    key: r.key,
    title: r.title || labelOf(r.key),
    category: r.category,
    coverage: r.coverage,
    confidence: r.coverageConfidence ?? 0.2,
    reason: r.coverageSource || 'unknown',
    suggestion: { coverage: r.coverage, appliesTo: r.appliesTo || [] },
  }))
}

export function normalizeRule(input = {}) {
  const key = String(input.key ?? input.id ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,80}$/.test(key)) throw new Error(`非法 key：${key}（只允许字母数字 . _ -，以字母开头）`)
  const scope = String(input.scope ?? 'global')
  const category = CATEGORIES.includes(input.category) ? input.category : (CATEGORIES.includes(key.split('.')[0]) ? key.split('.')[0] : 'imported')
  const priorityNum = Number(input.priority)
  const priority = Number.isFinite(priorityNum) ? priorityNum : scope === 'global' ? 100 : scopeRank(scope) * 100
  const status = ['active', 'pending', 'deprecated'].includes(input.status) ? input.status : 'active'
  const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))] : []
  const coverage = input.coverage === 'local' ? 'local' : (input.coverage === 'default' ? 'default' : undefined)
  const appliesTo = Array.isArray(input.appliesTo) ? [...new Set(input.appliesTo.map((d) => String(d).trim()).filter(Boolean))] : undefined
  return {
    id: `${scope}::${key}`,
    scope,
    category,
    key,
    title: String(input.title ?? '').trim(),   // 人类可读名称（可选；空则用 labelOf）
    value,
    priority,
    tags,                                       // 显式标签（分组/路由可命中；推断标签见 lib/tags.js）
    source: String(input.source ?? 'manual'),
    status,
    ...(String(input.explain ?? '').trim() ? { explain: String(input.explain).trim() } : {}),
    ...(String(input.decision ?? '').trim() ? { decision: String(input.decision).trim() } : {}),
    ...(String(input.option ?? '').trim() ? { option: String(input.option).trim() } : {}),
    ...(coverage ? { coverage } : {}),
    ...(appliesTo ? { appliesTo } : {}),
    ...(input.coverageSource ? { coverageSource: String(input.coverageSource) } : {}),
    updatedAt: input.updatedAt && typeof input.updatedAt === 'string' ? input.updatedAt : nowISO(),
  }
}

/** 把待复核队列里的建议落成显式字段（写回 rules.jsonl + 同步 AGENTS）。confidence 见 lib/coverage.js */
export function acceptCoverageSuggestions({ minConfidence = 0.6, keys = null } = {}) {
  const all = loadRules()
  const review = coverageReview(all)
  const wanted = new Set(keys || [])
  const todo = review.filter((x) => x.confidence >= minConfidence && (!wanted.size || wanted.has(x.key)))
  const byKey = new Map(todo.map((x) => [x.key, x]))
  const next = all.map((r) => {
    const hit = byKey.get(r.key)
    if (!hit) return r
    return { ...r, coverage: hit.suggestion.coverage, appliesTo: hit.suggestion.appliesTo || [], coverageSource: 'review' }
  })
  saveRules(next)
  const synced = syncAgents({ silent: true })
  return { accepted: todo.length, keys: todo.map((x) => x.key), synced, remaining: review.length - todo.length }
}

export function loadRules() {
  ensureDir()
  if (!fs.existsSync(STORE_FILE)) {
    // 默认空库：面向他人发布，每个人规则不同，不预置任何默认准则。
    // 需要示例/通用起点时，在 ~/.dsh/rules/config.json 里设 {"seedDefaults": true}
    const cfg = readRulesConfig()
    const seeded = cfg.seedDefaults === true ? readDefaults().map((r) => applyCoverage({ ...normalizeRule(r), source: r.source ?? 'defaults' })) : []
    saveRules(seeded)
    return seeded
  }
  const lines = fs.readFileSync(STORE_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const line of lines) {
    try { out.push(applyCoverage(normalizeRule(JSON.parse(line)))) } catch { /* 跳过坏行，不吞掉整个仓库 */ }
  }
  return out
}

export function saveRules(rules) {
  ensureDir()
  const map = new Map()
  for (const r of rules) map.set(normalizeRule(r).id, normalizeRule(r))
  const lines = [...map.values()].map((r) => JSON.stringify(r))
  const tmp = STORE_FILE + '.tmp'
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
  fs.renameSync(tmp, STORE_FILE)
  return [...map.values()]
}

export function upsertRule(input, { sync = true } = {}) {
  const rule = normalizeRule(input)
  const rules = loadRules()
  const idx = rules.findIndex((r) => r.id === rule.id)
  const before = idx >= 0 ? { ...rules[idx] } : null
  if (idx >= 0) {
    const merged = { ...rules[idx], ...rule, updatedAt: nowISO() }
    // 显式传空 explain / decision / option 时真的清掉，而不是保留旧值
    for (const f of ['explain', 'decision', 'option']) {
      if (Object.prototype.hasOwnProperty.call(input, f) && !String(input[f] ?? '').trim()) delete merged[f]
    }
    rules[idx] = merged
  } else rules.push(rule)
  const saved = saveRules(rules)
  const after = saved.find((r) => r.id === rule.id)
  recordRuleChange(before, after)
  const syncResult = sync ? syncAgents({ silent: true }) : null
  return { rule: after, synced: syncResult }
}

/* ---------------- 收集抑制清单：用户主动删掉的 collect 规则，读取时不再复活 ---------------- */
export const SUPPRESS_FILE = path.join(RULES_DIR, 'collect-suppressed.json')
export function loadCollectSuppressed() {
  try { return JSON.parse(fs.readFileSync(SUPPRESS_FILE, 'utf8')) || {} } catch { return {} }
}
export function clearCollectSuppressed() {
  try { fs.rmSync(SUPPRESS_FILE, { force: true }) } catch {}
}
function suppressCollected(rule) {
  if (!rule || !/\.collect_/.test(rule.key)) return
  try {
    const map = loadCollectSuppressed()
    const fp = `${rule.source || ''}|${rule.title || ''}`
    map[fp] = { key: rule.key, source: rule.source || '', title: rule.title || '', at: nowISO() }
    fs.mkdirSync(RULES_DIR, { recursive: true })
    fs.writeFileSync(SUPPRESS_FILE, JSON.stringify(map, null, 2), 'utf8')
  } catch {}
}

export function removeRule(key, scope = 'global') {
  const id = `${scope}::${key}`
  const rules = loadRules()
  const removed = rules.find((r) => r.id === id) || null
  const next = rules.filter((r) => r.id !== id)
  if (next.length === rules.length) return { removed: false }
  saveRules(next)
  suppressCollected(removed)
  recordRuleChange(removed, null)
  const synced = syncAgents({ silent: true })
  return { removed: true, synced, suppressed: Boolean(removed && /\.collect_/.test(removed.key)) }
}

/* ---------------- 改动记录（history.jsonl）：谁/什么时候/哪条/从什么改成什么 ---------------- */
const HISTORY_FIELDS = [
  ['title', '名称'], ['value', '内容'], ['explain', '白话解释'], ['category', '类别'],
  ['status', '状态'], ['source', '来源'], ['coverage', '适用面'], ['appliesTo', '适用任务域'],
  ['tags', '标签'], ['priority', '优先级'],
]
const flatVal = (v) => (v === undefined || v === null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)))
function appendHistory(entry) {
  try {
    fs.mkdirSync(RULES_DIR, { recursive: true })
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8')
    const st = fs.statSync(HISTORY_FILE)
    if (st.size > 1_500_000) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(HISTORY_FILE, lines.slice(-3000).join('\n') + '\n', 'utf8')
    }
  } catch {}
}
/** 记录一次规则改动（before/after 任一可为 null：新增 / 删除） */
export function recordRuleChange(before, after) {
  try {
    const action = before && after ? 'update' : after ? 'create' : before ? 'remove' : null
    if (!action) return
    const base = after || before
    const changes = []
    for (const [field, label] of HISTORY_FIELDS) {
      const from = flatVal(before ? before[field] : undefined)
      const to = flatVal(after ? after[field] : undefined)
      if (from !== to) changes.push({ field, label, from, to })
    }
    if (action === 'update' && !changes.length) return
    appendHistory({
      at: nowISO(), action, key: base.key, scope: base.scope,
      title: base.title || '', source: base.source || '', changes,
    })
  } catch {}
}
/** 读改动记录：默认最新在前，可按 key / action 过滤 */
export function loadHistory({ key = null, action = null, limit = 200 } = {}) {
  let lines = []
  try { lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
  const out = []
  const max = Math.max(1, Math.min(2000, Number(limit) || 200))
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    try {
      const e = JSON.parse(lines[i])
      if (!e || !e.key) continue
      if (key && e.key !== key) continue
      if (action && e.action !== action) continue
      out.push(e)
    } catch {}
  }
  return out
}
export function historyCount() {
  try { return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

/** 同 key 按优先级取生效项；可叠加 project 目录的项目级规则与会话级覆盖 */
export function resolveEffective(rules = loadRules(), { scope = 'global', task = '', keys = null, project = '', session = '', sessionDomain = '' } = {}) {
  const wanted = Array.isArray(keys) && keys.length ? new Set(keys) : null
  const pool = [...rules, ...(project ? loadProjectRules(project) : []), ...(session ? loadSessionRules(session) : [])]
  const filtered = pool.filter((r) => r.status === 'active')
  const sorted = [...filtered].sort((a, b) => (b.priority - a.priority) || (scopeRank(b.scope) - scopeRank(a.scope)))
  const winners = new Map()
  for (const r of sorted) if (!winners.has(r.key)) winners.set(r.key, r)
  let out = [...winners.values()]
  if (wanted) out = out.filter((r) => wanted.has(r.key))
  if (task) {
    const t = String(task).toLowerCase()
    const hit = out.filter((r) => (r.key + ' ' + r.value + ' ' + r.category).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i).some((w) => w.length > 1 && t.includes(w.toLowerCase())))
    if (hit.length) out = hit
  }
  // 本会话生效：默认域 + 按条 pin 的局部规则（永远并入，不写 AGENTS.md）
  const sessDefaults = session ? sessionDefaultRules(session) : []
  const have = new Set(out.map((r) => r.key))
  const extra = sessDefaults.filter((r) => !have.has(r.key))
  if (extra.length) out = [...out, ...extra]
  const sessKeys = new Set(sessDefaults.map((r) => r.key))
  if (out.length) recordUsage(out.map((r) => r.key))
  return out.map((r) => ({ key: r.key, title: r.title || labelOf(r.key), label: r.title || labelOf(r.key), category: r.category, categoryLabel: categoryLabel(r.category), value: r.value, scope: r.scope, priority: r.priority, source: r.source, status: r.status, coverage: r.coverage || 'default', appliesTo: r.appliesTo || [], coverageSource: r.coverageSource, coverageConfidence: r.coverageConfidence, needsReview: Boolean(r.needsReview), ...(r.decision ? { decision: r.decision } : {}), ...(r.option ? { option: r.option } : {}), updatedAt: r.updatedAt, sessionDefault: sessKeys.has(r.key) }))
}

// ---------- v2：项目级 scope / 会话覆盖 / 使用统计 / 健康报告 / AGENTS 回滚 ----------
export const PROJECT_FILE = '.dsh-rules.json'
export const SESSION_OVERRIDES = path.join(RULES_DIR, 'session-overrides.json')
export const USAGE_FILE = path.join(RULES_DIR, 'usage.jsonl')

/** 读项目目录下的 .dsh-rules.json，归一化为 project:<dir> 作用域规则 */
export function loadProjectRules(projectDir) {
  const dir = String(projectDir || '').trim()
  if (!dir) return []
  const file = path.isAbsolute(dir) ? path.join(dir, PROJECT_FILE) : path.join(process.cwd(), dir, PROJECT_FILE)
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(j) ? j : (Array.isArray(j.rules) ? j.rules : [])
    return list.map((r) => applyCoverage(normalizeRule({ ...r, scope: `project:${dir}`, source: r.source ?? PROJECT_FILE })))
  } catch { return [] }
}

/** 会话级覆盖：~/.dsh/rules/session-overrides.json；v1 = { "<tag>": [rules] }，v2 增加 profiles.{tag}=会话默认域 */
export const SESSION_TTL_DAYS = 7
function readSessionFile() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_OVERRIDES, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}
function writeSessionFile(j) {
  ensureDir()
  fs.writeFileSync(SESSION_OVERRIDES, JSON.stringify(j, null, 2) + '\n', 'utf8')
}
/** 清掉过期会话默认（7 天 TTL）；返回清理数量 */
export function pruneSessionProfiles() {
  const j = readSessionFile()
  const profiles = j.profiles && typeof j.profiles === 'object' ? j.profiles : {}
  let n = 0
  const now = Date.now()
  for (const [tag, p] of Object.entries(profiles)) {
    const exp = p && p.expiresAt ? Date.parse(p.expiresAt) : 0
    if (!exp || exp <= now) { delete profiles[tag]; n++ }
  }
  if (n) { j.profiles = profiles; writeSessionFile(j) }
  return n
}
/** 设定本会话默认域（只在该会话内把该域的局部规则当成默认） */
export function setSessionProfile(tag, { domain, label = '', ttlDays = SESSION_TTL_DAYS } = {}) {
  const t = String(tag || '').trim()
  if (!t) throw new Error('缺少会话 tag（session id）')
  const d = String(domain || '').trim()
  if (!d) throw new Error('缺少默认域 domain，例如 ppt / paper')
  const known = Object.keys(coverageDomains() || {})
  if (known.length && !known.includes(d)) throw new Error(`未知任务域：${d}（可用：${known.join(' / ')}）`)
  const j = readSessionFile()
  j.profiles = (j.profiles && typeof j.profiles === 'object') ? j.profiles : {}
  const at = nowISO()
  const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays) || SESSION_TTL_DAYS) * 86400_000).toISOString()
  const prev = j.profiles[t] || {}
  j.profiles[t] = { domain: d, label: String(label || ''), pinnedAt: at, expiresAt, pins: Array.isArray(prev.pins) ? prev.pins : [] }
  writeSessionFile(j)
  return j.profiles[t]
}
/** 按条翻「本对话生效」：pins 存 key 列表；on=false 取消。局部规则默认未生效，翻过之后只在该会话生效 */
export function pinSessionRules(tag, keys, on = true) {
  const t = String(tag || '').trim()
  if (!t) throw new Error('缺少会话 tag（session id）')
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean)
  if (!list.length) throw new Error('缺少规则 key')
  const j = readSessionFile()
  j.profiles = (j.profiles && typeof j.profiles === 'object') ? j.profiles : {}
  const at = nowISO()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString()
  const p = j.profiles[t] || { domain: '', label: '', pinnedAt: at, expiresAt, pins: [] }
  const set = new Set(Array.isArray(p.pins) ? p.pins : [])
  for (const k of list) { if (on) set.add(k); else set.delete(k) }
  p.pins = [...set]
  p.pinnedAt = at
  p.expiresAt = expiresAt
  if (!p.domain && !p.pins.length) delete j.profiles[t]
  else j.profiles[t] = p
  writeSessionFile(j)
  return p.pins
}
export function loadSessionProfile(tag) {
  const t = String(tag || '').trim()
  if (!t) return null
  pruneSessionProfiles()
  const p = readSessionFile().profiles?.[t]
  if (!p) return null
  return (p.domain || (p.pins || []).length) ? p : null
}
export function clearSessionProfile(tag) {
  const t = String(tag || '').trim()
  const j = readSessionFile()
  if (j.profiles?.[t]) { delete j.profiles[t]; writeSessionFile(j); return true }
  return false
}
export function listSessionProfiles() {
  pruneSessionProfiles()
  const profiles = readSessionFile().profiles ?? {}
  return Object.entries(profiles).map(([tag, p]) => ({ tag, ...p }))
}
/** 本会话生效的规则 = 默认域规则 + 按条 pin 的规则（不写 AGENTS.md） */
export function sessionDefaultRules(tag) {
  const p = loadSessionProfile(tag)
  if (!p) return []
  const all = loadRules().filter((r) => r.status === 'active')
  const picked = []
  const seen = new Set()
  if (p.domain) {
    for (const r of all) {
      if (r.coverage !== 'local' || !(r.appliesTo || []).includes(p.domain)) continue
      if (seen.has(r.key)) continue
      seen.add(r.key)
      picked.push({ ...r, _why: `session-domain:${p.domain}` })
    }
  }
  const pins = new Set(p.pins || [])
  for (const r of all) {
    if (!pins.has(r.key) || seen.has(r.key)) continue
    seen.add(r.key)
    picked.push({ ...r, _why: `session-pin` })
  }
  return picked.map((r) => applyCoverage(normalizeRule({ ...r, scope: `session:${tag}`, coverage: 'default', appliesTo: [], source: r._why, priority: r.priority ?? 100 })))
}

export function loadSessionRules(tag) {
  const t = String(tag || '').trim()
  if (!t) return []
  try {
    const j = readSessionFile()
    const list = Array.isArray(j[t]) ? j[t] : []
    return list.map((r) => applyCoverage(normalizeRule({ ...r, scope: `session:${t}`, source: r.source ?? 'session-override' })))
  } catch { return [] }
}

export function setSessionRules(tag, list) {
  const t = String(tag || '').trim()
  if (!t) throw new Error('缺少会话 tag')
  const j = readSessionFile()
  if (!list || !list.length) delete j[t]
  else j[t] = list
  writeSessionFile(j)
  return j[t] ?? []
}

export function recordUsage(keys) {
  try {
    ensureDir()
    fs.appendFileSync(USAGE_FILE, JSON.stringify({ at: nowISO(), keys: [...new Set(keys)].slice(0, 200) }) + '\n')
  } catch {}
}

export function loadUsage() {
  const count = {}
  try {
    for (const line of fs.readFileSync(USAGE_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let j = null
      try { j = JSON.parse(line) } catch { continue }
      for (const k of j.keys ?? []) count[k] = (count[k] ?? 0) + 1
    }
  } catch {}
  return count
}

export function healthReport(rules = loadRules(), { project = '' } = {}) {
  const a = auditRules(rules)
  const usage = loadUsage()
  const projectRules = project ? loadProjectRules(project) : []
  const active = rules.filter((r) => r.status === 'active')
  const stale = active.filter((r) => Date.now() - Date.parse(r.updatedAt) > 90 * 86400000).map((r) => r.key)
  const unusedActive = active.filter((r) => !usage[r.key]).map((r) => r.key)
  const coverageGaps = CATEGORIES.filter((c) => !active.some((r) => r.category === c))
  return {
    generatedAt: nowISO(),
    total: rules.length, active: a.active, pending: a.pendingCount, conflicts: a.conflicts.length,
    byCategory: a.byCategory,
    project: { dir: project || null, rules: projectRules.length },
    stale, unusedActive, coverageGaps,
    topUsed: Object.entries(usage).sort((x, y) => y[1] - x[1]).slice(0, 10),
    agentsBackups: listAgentsBackups().length,
  }
}

export function listAgentsBackups() {
  try {
    return fs.readdirSync(DSH_DIR).filter((f) => f.startsWith('AGENTS.md.bak-dsh-rules-')).sort().reverse()
  } catch { return [] }
}

/** 回滚 AGENTS.md 到某个 dsh-rules 备份（先给当前文件再留一份 pre-rollback 备份） */
export function restoreAgentsBackup(name) {
  const file = path.join(DSH_DIR, String(name))
  if (!/^AGENTS\.md\.bak-dsh-rules-[\dTZ.-]+$/.test(path.basename(file))) throw new Error('备份文件名不合法：' + name)
  if (!fs.existsSync(file)) throw new Error('备份不存在：' + name)
  const current = fs.existsSync(AGENTS_FILE) ? fs.readFileSync(AGENTS_FILE, 'utf8') : ''
  if (current) fs.writeFileSync(`${AGENTS_FILE}.bak-dsh-rules-prerollback-${new Date().toISOString().replace(/[:.]/g, '-')}`, current, 'utf8')
  fs.copyFileSync(file, AGENTS_FILE)
  return { restored: path.basename(file), bytes: fs.statSync(AGENTS_FILE).size }
}

export function auditRules(rules = loadRules()) {
  const active = rules.filter((r) => r.status === 'active')
  const byKey = new Map()
  for (const r of active) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r) }
  const conflicts = []
  for (const [key, list] of byKey) {
    const vals = new Set(list.map((r) => r.value))
    if (vals.size > 1 && new Set(list.map((r) => r.priority + '|' + scopeRank(r.scope))).size === 1) {
      conflicts.push({ key, values: [...vals], sources: list.map((r) => r.source) })
    }
  }
  const pending = rules.filter((r) => r.status === 'pending').map((r) => ({ key: r.key, value: r.value, source: r.source }))
  const noSource = rules.filter((r) => !r.source || r.source === 'manual').length
  const unknownCategory = rules.filter((r) => !CATEGORIES.includes(r.category)).map((r) => r.key)
  const deprecated = rules.filter((r) => r.status === 'deprecated').length
  const cov = coverageCounts(rules)
  const unclassified = rules.filter((r) => r.coverageSource === 'fallback' || r.needsReview).map((r) => r.key)
  const bySource = {}
  for (const r of rules) bySource[r.coverageSource || 'unknown'] = (bySource[r.coverageSource || 'unknown'] || 0) + 1
  const domainCount = {}
  for (const r of rules) if (r.coverage === 'local') for (const d of r.appliesTo || []) domainCount[d] = (domainCount[d] || 0) + 1
  return {
    total: rules.length,
    active: active.length,
    pendingCount: pending.length,
    pending: pending.slice(0, 20),
    conflicts,
    noSource,
    unknownCategory,
    deprecated,
    coverage: { ...cov, byDomain: domainCount, bySource, unclassified },
    byCategory: CATEGORIES.map((c) => ({ category: c, count: rules.filter((r) => r.category === c).length })).filter((x) => x.count),
  }
}

/** 摘要渲染配置：~/.dsh/rules/config.json 可覆盖（digest: 'summary'|'full'，maxValue: 数字，seedDefaults: 布尔） */
export function readRulesConfig() {
  const defaults = { digest: 'summary', maxValue: 60, seedDefaults: false }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'config.json'), 'utf8'))
    return { ...defaults, ...j }
  } catch { return defaults }
}

function digestLines(rules, { full = false, maxValue = 60 } = {}) {
  // 摘要默认只注入「默认规则」（不绑定任务的常驻准则）；局部规则按任务域路由，不占常驻上下文
  const active = resolveEffective(rules).filter((r) => full || r.coverage === 'default')
  const byCat = new Map()
  for (const r of active) { if (!byCat.has(r.category)) byCat.set(r.category, []); byCat.get(r.category).push(r) }
  const lines = []
  for (const cat of CATEGORIES) {
    const list = byCat.get(cat)
    if (!list || !list.length) continue
    lines.push(`### ${full ? cat : categoryLabel(cat)}`)
    const perCat = full ? list.length : 15
    const shown = list.sort((a, b) => a.key.localeCompare(b.key)).slice(0, perCat)
    for (const r of shown) {
      const v = String(r.value).replace(/\s+/g, ' ').slice(0, full ? 240 : maxValue)
      const suffix = full && r.coverage === 'local' ? `（局部：${(r.appliesTo || []).map(domainLabel).join('/')}）` : ''
      lines.push(full ? `- \`${r.key}\` = ${v}${suffix}` : `- ${r.title || labelOf(r.key)}：${v}${String(r.value).length > maxValue ? '…' : ''}`)
    }
    if (!full && list.length > shown.length) lines.push(`- …（本类共 ${list.length} 条，其余 ${list.length - shown.length} 条用 rules_query 查）`)
  }
  return lines
}

export function renderDigest(rules = loadRules(), { title = '统一准则（dsh-rules 自动生成）', full, maxValue } = {}) {
  const cfg = readRulesConfig()
  const useFull = full === undefined ? cfg.digest === 'full' : Boolean(full)
  const limit = maxValue ?? (cfg.maxValue || 60)
  const active = resolveEffective(rules)
  const { default: nDefault, local: nLocal } = coverageCounts(active)
  const domains = [...new Set(active.filter((r) => r.coverage === 'local').flatMap((r) => r.appliesTo || []))]
  const domainHint = domains.length ? `${domains.length} 个任务域（${domains.join(' / ')}）` : '无'
  const header = useFull
    ? `> 生效规则 ${active.length} 条（完整模式，含局部 ${nLocal} 条）；本段由 dsh-rules 插件自动生成并同步到 ~/.dsh/AGENTS.md，请勿手改（要改规则用 dsh-rules 工具/CLI）。`
    : `> 常驻 **默认规则 ${nDefault} 条**（不绑定任务，任何会话都生效）；另有 **局部规则 ${nLocal} 条**按任务域按需路由（${domainHint}），用 \`rules_route\`（任务描述）或 \`rules_query\`（关键词，可加 coverage=local）取；托管段勿手改。`
  const review = active.filter((r) => r.needsReview)
  const reviewHint = review.length
    ? `> ⚠️ 适用面**待复核 ${review.length} 条**（推断置信不足，当前按推断值生效，例如：${review.slice(0, 4).map((r) => r.key).join('、')}${review.length > 4 ? ' …' : ''}）：用 \`rules_coverage op=review\` 看建议，确认后 \`op=accept\` 落定。`
    : ''
  return [`## ${title}`, '', ...[header, reviewHint].filter(Boolean), '', ...digestLines(rules, { full: useFull, maxValue: limit }), ''].join('\n')
}

export function renderMarkdown(rules = loadRules()) {
  const active = resolveEffective(rules)
  const rows = active.map((r) => `| \`${r.key}\` | ${String(r.value).replace(/\|/g, '\\|')} | ${r.category} | ${r.scope} | ${r.coverage || 'default'}${r.appliesTo?.length ? ':' + r.appliesTo.join('+') : ''} | ${r.source} | ${r.updatedAt.slice(0, 10)} |`)
  return ['| key | value | category | scope | coverage | source | updated |', '|---|---|---|---|---|---|---|', ...rows].join('\n')
}

/** 把托管段写入 ~/.dsh/AGENTS.md（保留手写内容；内容不变则不写）。默认摘要模式，full:true 写完整版 */
export function syncAgents({ dryRun = false, silent = false, full } = {}) {
  ensureDir()
  const digest = renderDigest(loadRules(), full === undefined ? {} : { full: Boolean(full) })
  const section = `${MARK_BEGIN}\n${digest}${MARK_END}\n`
  let text = ''
  try { text = fs.readFileSync(AGENTS_FILE, 'utf8') } catch { text = '' }
  // 先移除旧托管段（可能在任意位置），再统一放到文件开头——AGENTS.md 太长时上下文预算会截断尾部，
  // 常驻规则放末尾等于没注入
  let clean = text
  if (clean.includes(MARK_BEGIN)) {
    const start = clean.indexOf(MARK_BEGIN)
    const end = clean.indexOf(MARK_END, start)
    if (end < 0) throw new Error('AGENTS.md 里托管段缺少结束标记，请人工检查')
    clean = (clean.slice(0, start) + clean.slice(end + MARK_END.length)).replace(/\n{3,}/g, '\n\n')
  }
  const heading = clean.match(/^#[^\n]*\n/)
  const next = heading
    ? heading[0] + '\n' + section + clean.slice(heading[0].length).replace(/^\n+/, '')
    : section + clean.trimStart()
  let backup = null
  const changed = next !== text
  const agentsBytes = Buffer.byteLength(next, 'utf8')
  const digestBytes = Buffer.byteLength(section, 'utf8')
  // 上下文预算约 64–65KB；超了尾部会被截断（托管段在开头所以规则安全，但手写内容会被切）
  const warnings = []
  if (agentsBytes > 65000) warnings.push(`AGENTS.md 已 ${(agentsBytes / 1024).toFixed(1)}KB，超过约 65KB 的上下文预算：托管段在开头不受影响，但文件尾部手写内容会被截断（建议把长文拆到项目级 AGENTS.md）`)
  if (digestBytes > 30000) warnings.push(`默认规则摘要已 ${(digestBytes / 1024).toFixed(1)}KB（占预算近一半）：默认规则过多，建议把非全局规则改成局部，否则会挤掉其他上下文`)
  if (!changed) return { changed: false, bytes: agentsBytes, digestBytes, warnings }
  if (dryRun) return { changed: true, dryRun: true, bytes: agentsBytes, digestBytes, warnings }
  if (text) {
    backup = `${AGENTS_FILE}.bak-dsh-rules-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.writeFileSync(backup, text, 'utf8')
    // 只保留最近 5 个托管段备份
    try {
      const old = fs.readdirSync(DSH_DIR).filter((f) => f.startsWith('AGENTS.md.bak-dsh-rules-')).sort()
      for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.rmSync(path.join(DSH_DIR, f), { force: true })
    } catch {}
  }
  fs.writeFileSync(AGENTS_FILE, next, 'utf8')
  if (!silent) console.log(`[dsh-rules] 已同步 ${AGENTS_FILE}${backup ? '（备份 ' + path.basename(backup) + '）' : ''}`)
  for (const w of warnings) if (!silent) console.warn('[dsh-rules] ⚠ ' + w)
  return { changed: true, bytes: agentsBytes, digestBytes, warnings, backup }
}

export function readActiveStylePacks() {
  try { return JSON.parse(fs.readFileSync(path.join(DSH_DIR, 'style-packs', 'active.json'), 'utf8')) } catch { return null }
}
