import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadRules, auditRules, loadCollectSuppressed, CATEGORIES } from './store.js'

/* ---------- 问题台账：把库里的“问题”按归属归类，交给助手汇报 ---------- */

const home = () => os.homedir()

/** 来源标签 → 可能的实际文件路径（用于检测“源已消失”） */
export function resolveSourcePath(label) {
  const s = String(label || '')
  if (!s) return null
  if (s === 'AGENTS.md') return path.join(home(), '.dsh', 'AGENTS.md')
  if (s === 'EXPERIENCE.md') return path.join(home(), '.dsh', 'EXPERIENCE.md')
  if (s === '项目 AGENTS.md') return path.join(process.cwd(), 'AGENTS.md')
  if (s.startsWith('技能:')) return path.join(home(), '.dsh', 'skills', s.slice(3), 'SKILL.md')
  if (s.startsWith('技能:.agents/')) { const n = s.slice('技能:.agents/'.length); return path.join(home(), '.agents', 'skills', n, 'SKILL.md') }
  if (s.startsWith('插件技能:')) {
    const rest = s.slice('插件技能:'.length)
    const slash = rest.lastIndexOf('/')
    const pkg = rest.slice(0, slash), skill = rest.slice(slash + 1)
    const profiles = path.join(home(), '.dsh', 'profiles')
    try {
      for (const p of fs.readdirSync(profiles)) {
        for (const sub of ['skills', 'skill']) {
          const f = path.join(profiles, p, 'node_modules', pkg, sub, skill, 'SKILL.md')
          if (fs.existsSync(f)) return f
        }
      }
    } catch {}
    return path.join(profiles, 'desktop', 'node_modules', pkg, 'skills', skill, 'SKILL.md')
  }
  if (s.startsWith('style-packs:')) {
    const [domain, pack] = s.slice('style-packs:'.length).split('/')
    return path.join(home(), '.dsh', 'style-packs', domain, pack, 'rules.json')
  }
  return null
}

const sevRank = { high: 3, medium: 2, low: 1 }
const norm = (s) => String(s).toLowerCase().replace(/[\s，。；、：:,.!?！？"'“”‘’()（）\[\]【】<>《》/\\|_=+~`*#-]/g, '')

/**
 * 扫描问题台账。
 * 每个问题都有 owner（归属）：来源名 / 状态分类 / 冲突 / 抑制清单 / 字段。
 * @returns {{generatedAt:string,total:number,groups:Array,bySeverity:object}}
 */
export function scanIssues() {
  const rules = loadRules()
  const audit = auditRules(rules)
  const groups = []
  const push = (owner, kind, severity, items, suggestion) => {
    if (!items.length) return
    groups.push({ owner, kind, severity, count: items.length, items: items.slice(0, 8), suggestion })
  }

  // 1) 待复核（状态归属）
  const pending = rules.filter((r) => r.status === 'pending')
  push('待复核', 'pending 未确认', pending.length > 20 ? 'high' : 'medium',
    pending.map((r) => ({ key: r.key, title: r.title, detail: String(r.value).slice(0, 60), source: r.source })),
    '让我逐条判断（生效/删除/保留），说「帮我校准待复核」')

  // 2) 冲突（同 key 不同内容）
  push('冲突', '同 key 不同内容', 'high',
    audit.conflicts.map((c) => ({ key: c.key, title: c.key, detail: c.values.map((v) => String(v).slice(0, 40)).join(' ≠ ') })),
    '按优先级/来源确认哪条为准，或删掉旧条目')

  // 3) 同来源同标题多条（多为截断重名，也可能是真重复）
  const byTitle = new Map()
  for (const r of rules) {
    const k = `${r.source || ''}|${r.title || ''}`
    if (!byTitle.has(k)) byTitle.set(k, [])
    byTitle.get(k).push(r)
  }
  const dupTitles = [...byTitle.entries()].filter(([, v]) => v.length > 1)
  for (const [k, list] of dupTitles.slice(0, 20)) {
    const [src, title] = k.split('|')
    push(src || '未标来源', '同标题多条', list.length > 3 ? 'medium' : 'low',
      list.map((r) => ({ key: r.key, title, detail: String(r.value).slice(0, 50) })),
      '确认是否确实是不同规则；重名可改标题')
  }

  // 4) 完全相同内容（归一化后）
  const byNorm = new Map()
  for (const r of rules) {
    const n = norm(r.value)
    if (!n) continue
    if (!byNorm.has(n)) byNorm.set(n, [])
    byNorm.get(n).push(r)
  }
  const exactDup = [...byNorm.values()].filter((v) => v.length > 1)
  push('重复', '内容完全相同', exactDup.length > 10 ? 'high' : 'medium',
    exactDup.map((list) => ({ key: list.map((r) => r.key).join(' / '), title: list[0].title, detail: String(list[0].value).slice(0, 50) })),
    '保留一条，其余删除')

  // 5) 来源文件已不存在（收集类规则）
  const missing = []
  for (const r of rules) {
    if (!/\.collect_/.test(r.key)) continue
    const p = resolveSourcePath(r.source)
    if (p && !fs.existsSync(p)) missing.push({ key: r.key, title: r.title, detail: `来源不存在：${r.source}` })
  }
  push('来源失效', '源文件已不存在', 'medium', missing, '删除这些规则，或恢复来源文件后重新读取')

  // 6) 抑制清单（用户删过的收集规则）
  const sup = loadCollectSuppressed()
  push('抑制清单', '已手动删除的收集规则', 'low',
    Object.entries(sup).map(([fp, v]) => ({ key: v.key || fp, title: v.title || fp, detail: '读取时不会复活' })),
    '想恢复就 `collect --reset-suppressed` 后重新读取')

  // 7) 字段异常 / 未知类别 / 无来源
  const bad = rules.filter((r) => !String(r.value || '').trim() || String(r.value).length < 6)
  push('字段异常', '内容为空或过短', 'high',
    bad.map((r) => ({ key: r.key, title: r.title, detail: String(r.value || '') })),
    '补全或删除')
  push('字段异常', '未知类别', 'low',
    audit.unknownCategory.map((k) => ({ key: k, title: k, detail: '类别不在 CATEGORIES 内' })),
    `改成 ${CATEGORIES.slice(0, 6).join('/')} 等标准类别`)

  // 8) 适用面待定
  push('适用面', 'coverage 待校准', 'low',
    rules.filter((r) => r.needsReview).map((r) => ({ key: r.key, title: r.title, detail: '适用面推断置信不足' })),
    '用 rules_coverage review/accept 处理，或在面板改默认/局部')

  const total = groups.reduce((a, g) => a + g.count, 0)
  const bySeverity = { high: 0, medium: 0, low: 0 }
  for (const g of groups) bySeverity[g.severity] += g.count
  groups.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || b.count - a.count)
  return { generatedAt: new Date().toISOString(), total, bySeverity, groups }
}

/** 给助手/CLI 用的紧凑摘要 */
export function issuesSummary(issues = scanIssues(), { lines = 8 } = {}) {
  const head = `问题台账：共 ${issues.total} 个问题（高 ${issues.bySeverity.high} / 中 ${issues.bySeverity.medium} / 低 ${issues.bySeverity.low}）`
  const rows = issues.groups.slice(0, lines).map((g) => `- [${g.severity}] ${g.owner} · ${g.kind}：${g.count} 个 —— ${g.suggestion}`)
  return [head, ...rows].join('\n')
}
