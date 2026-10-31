import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadRules, upsertRule, syncAgents, CATEGORIES, loadCollectSuppressed, clearCollectSuppressed } from './store.js'

/* ---------- 「读取规则」= 扫描系统现有准则来源并收录 ---------- */

const norm = (s) => String(s).toLowerCase().replace(/[\s，。；、：:,.!?！？"'“”‘’()（）\[\]【】<>《》/\\|_=+~`*#-]/g, '')
const hash8 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return (h >>> 0).toString(16).padStart(8, '0') }

/** 关键词加权分类（比“首个命中”更稳；默认 workflow） */
function categorize(text) {
  const t = String(text)
  const score = {}
  const add = (cat, re, w) => {
    const m = t.match(re)
    if (m) score[cat] = (score[cat] || 0) + m.length * w
  }
  add('safety', /(删除|覆盖|不可逆|账号|密钥|脱敏|安全|红线|确认|备份|权限|凭据)/g, 2)
  add('paths', /(下载|安装位置|安装目录|安装到|便携版|镜像|目录|路径|放到|存放|默认目录)/g, 2)
  add('style', /(PPT|幻灯片|排版|字体|配色|模板|版式|封面|论文写作|论文格式|报告结构|风格包)/gi, 3)
  add('tools', /(工具|脚本|命令行|优先用|选型|python|node|ffmpeg|blender|excel|word|pptx|docx|浏览器|插件)/gi, 1)
  add('model', /(模型|计价|成本|token|费用|时段|上下文预算|空闲)/gi, 2)
  add('skill', /(技能|技能包|SKILL\.md|体检|安装技能)/gi, 2)
  add('workflow', /(先.*?再|批量|改动|证据|结论|验证|审计|流程|步骤|汇报|回复|简洁|默认)/g, 1)
  let best = 'workflow'
  let bestScore = 0
  for (const c of CATEGORIES) {
    const s = score[c] || 0
    if (s > bestScore) { bestScore = s; best = c }
  }
  return best
}

/** 稳定标题：取第一句/冒号前，附所属小节 */
function makeTitle(value, heading) {
  let t = String(value).split(/[。！？!?；;：:（(]/)[0].trim()
  if (t.length > 26) t = t.slice(0, 26)
  if (!t) t = String(value).slice(0, 24)
  const title = heading && !t.startsWith(heading) ? `${heading}：${t}` : t
  return title.slice(0, 44)
}

/** 长条目按分号拆成多条（每段 ≥12 字，最多 3 段） */
function splitClauses(value) {
  const v = String(value).trim()
  const parts = v.split(/[；;]/).map((s) => s.trim()).filter((s) => s.length >= 12)
  if (parts.length < 2 || parts.length > 3) return [v]
  const total = parts.reduce((a, b) => a + b.length, 0)
  if (total > 320) return [v]
  return parts
}

function wordBigrams(s) {
  const t = String(s).replace(/\s/g, '')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
function similarity(a, b) {
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / ((a.size + b.size - inter) || 1)
}

/**
 * 从 markdown 提取候选准则
 * @param {string} file 文件路径
 * @param {string} label 来源标签
 * @param {object} out 输出数组
 */
function fromMarkdown(file, label, out, { onlyRuleLike = false, status = 'active', cap = 400 } = {}) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return 0 }
  if (label === 'AGENTS.md') {
    const b = text.indexOf('<!-- dsh-rules:begin')
    const e = text.indexOf('<!-- dsh-rules:end')
    if (b !== -1 && e !== -1) text = text.slice(0, b) + text.slice(e + '<!-- dsh-rules:end -->'.length)
  }
  const before = out.length
  let inFence = false
  let heading = ''
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue }
    if (inFence) continue
    const h = raw.match(/^#{1,4}\s+(.+)$/)
    if (h) { heading = h[1].trim(); continue }
    const m = raw.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/)
    if (!m) continue
    const v = m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/^\s*\[[ xX]\]\s*/, '').trim()
    if (v.length < 12 || v.length > 360) continue
    if (/^https?:\/\//.test(v)) continue
    if (/^(示例|例如|比如|注：|备注[:：])/.test(v)) continue
    if (onlyRuleLike && !/(必须|不要|禁止|一律|优先|默认|避免|应当|不得|统一|只用|不要用|先.*?再|不能|禁止)/.test(v)) continue
    for (const piece of splitClauses(v)) {
      out.push({ value: piece, title: makeTitle(piece, heading), category: categorize(piece), source: label, status })
      if (out.length - before >= cap) return out.length - before
    }
  }
  return out.length - before
}

/** 扫 profile node_modules 里插件自带的 skills */
function fromPluginSkills(out) {
  const home = os.homedir()
  const profilesDir = path.join(home, '.dsh', 'profiles')
  let n = 0
  let profiles = []
  try { profiles = fs.readdirSync(profilesDir) } catch { return 0 }
  for (const prof of profiles) {
    const nm = path.join(profilesDir, prof, 'node_modules')
    let entries = []
    try { entries = fs.readdirSync(nm) } catch { continue }
    const pkgDirs = []
    for (const ent of entries) {
      if (ent.startsWith('.')) continue
      if (ent.startsWith('@')) {
        try { for (const sub of fs.readdirSync(path.join(nm, ent))) pkgDirs.push(path.join(ent, sub)) } catch {}
      } else pkgDirs.push(ent)
    }
    for (const pkg of pkgDirs) {
      for (const sub of ['skills', 'skill']) {
        const d = path.join(nm, pkg, sub)
        let skills = []
        try { skills = fs.readdirSync(d) } catch { continue }
        for (const sk of skills) {
          const f = path.join(d, sk, 'SKILL.md')
          if (!fs.existsSync(f)) continue
          n += fromMarkdown(f, `插件技能:${pkg}/${sk}`, out, { onlyRuleLike: true, status: 'pending', cap: 30 })
          if (n >= 300) return n
        }
      }
    }
  }
  return n
}

/** 扫 style-packs 的结构化规则 */
function fromStylePacks(out) {
  const home = os.homedir()
  const root = path.join(home, '.dsh', 'style-packs')
  let n = 0
  let domains = []
  try { domains = fs.readdirSync(root) } catch { return 0 }
  for (const domain of domains) {
    const dd = path.join(root, domain)
    let packs = []
    try { if (!fs.statSync(dd).isDirectory()) continue; packs = fs.readdirSync(dd) } catch { continue }
    for (const pack of packs) {
      const rf = path.join(dd, pack, 'rules.json')
      if (!fs.existsSync(rf)) continue
      let data = []
      try { data = JSON.parse(fs.readFileSync(rf, 'utf8')) } catch { continue }
      const arr = Array.isArray(data) ? data : (Array.isArray(data.rules) ? data.rules : [])
      for (const r of arr) {
        const value = typeof r === 'string' ? r : (r.value || r.text || r.rule)
        if (!value || String(value).length < 12) continue
        out.push({ value: String(value), title: String((r && (r.title || r.name)) || `${domain}/${pack}`).slice(0, 44), category: 'style', source: `style-packs:${domain}/${pack}`, status: 'pending' })
        n++
      }
    }
  }
  return n
}

/** 收集候选（不写库） */
export function collectCandidates({ includePlugins = true } = {}) {
  const out = []
  const home = os.homedir()
  fromMarkdown(path.join(home, '.dsh', 'AGENTS.md'), 'AGENTS.md', out, { cap: 500 })
  fromMarkdown(path.join(home, '.dsh', 'EXPERIENCE.md'), 'EXPERIENCE.md', out, { cap: 200 })
  fromMarkdown(path.join(process.cwd(), 'AGENTS.md'), '项目 AGENTS.md', out, { cap: 200 })
  // 用户级技能
  try {
    const dir = path.join(home, '.dsh', 'skills')
    let n = 0
    for (const name of fs.readdirSync(dir)) {
      if (n >= 240) break
      const f = path.join(dir, name, 'SKILL.md')
      if (!fs.existsSync(f)) continue
      n += fromMarkdown(f, `技能:${name}`, out, { onlyRuleLike: true, status: 'pending', cap: 40 })
    }
  } catch {}
  // anthropics 风格技能目录
  try {
    const dir = path.join(home, '.agents', 'skills')
    let n = 0
    for (const name of fs.readdirSync(dir)) {
      if (n >= 120) break
      const f = path.join(dir, name, 'SKILL.md')
      if (!fs.existsSync(f)) continue
      n += fromMarkdown(f, `技能:.agents/${name}`, out, { onlyRuleLike: true, status: 'pending', cap: 30 })
    }
  } catch {}
  // 插件自带技能
  if (includePlugins) fromPluginSkills(out)
  // 风格包
  fromStylePacks(out)
  return out
}

/**
 * 收录进规则库（默认 dryRun=false）
 * 去重：完全相同、key 冲突、字符二元组相似度 ≥0.86 视为重复
 */
export function collectRules({ dryRun = false, includePlugins = true, resetSuppressed = false } = {}) {
  if (resetSuppressed && !dryRun) clearCollectSuppressed()
  const suppressed = resetSuppressed ? {} : loadCollectSuppressed()
  const cands = collectCandidates({ includePlugins })
  const existing = loadRules()
  const existingKeys = new Set(existing.map((r) => r.key))
  const seenNorm = new Set(existing.map((r) => norm(r.value)))
  const existingBigrams = existing.map((r) => wordBigrams(norm(r.value)))
  const newBigrams = []
  const perSource = {}
  let added = 0
  let skipped = 0
  for (const c of cands) {
    perSource[c.source] = (perSource[c.source] || 0) + 1
    // 用户主动删过的 collect 规则：不再复活（resetSuppressed 可清空）
    if (suppressed[`${c.source}|${c.title}`]) { skipped++; continue }
    const nv = norm(c.value)
    if (nv.length < 8 || seenNorm.has(nv)) { skipped++; continue }
    const bg = wordBigrams(nv)
    let dup = false
    for (const e of existingBigrams) if (similarity(bg, e) >= 0.86) { dup = true; break }
    if (!dup) for (const e of newBigrams) if (similarity(bg, e) >= 0.86) { dup = true; break }
    if (dup) { skipped++; continue }
    const cat = CATEGORIES.includes(c.category) ? c.category : 'workflow'
    const key = `${cat}.collect_${hash8(nv)}`
    if (existingKeys.has(key)) { skipped++; continue }
    if (dryRun) { added++; seenNorm.add(nv); newBigrams.push(bg); continue }
    try {
      upsertRule({ key, title: c.title, value: c.value, category: cat, source: c.source, status: c.status, scope: 'global', sync: false }, { sync: false })
      existingKeys.add(key)
      seenNorm.add(nv)
      newBigrams.push(bg)
      added++
    } catch { skipped++ }
  }
  if (!dryRun && added) { try { syncAgents({ silent: true }) } catch {} }
  return { candidates: cands.length, added, skipped, perSource, dryRun, suppressedSkipped: Object.keys(suppressed).length }
}
