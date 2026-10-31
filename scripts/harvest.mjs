#!/usr/bin/env node
/**
 * dsh-rules · 准则收割器（harvest）
 *
 * 目标：不是"挑几个技能读一读"，而是把所有可能藏准则的来源**全部建账**：
 *   1) 用户级技能 ~/.dsh/skills/<技能>/SKILL.md（+ references/ 文件清单）
 *   2) 插件捆绑技能 <profile>/node_modules/<插件>/skills/<技能>/SKILL.md
 *   3) ~/.dsh/AGENTS.md（手写长期规则）
 *   4) ~/.dsh/EXPERIENCE.md（实践教训）
 *   5) 插件/实例配置里需要纳入的 persona、规则文件（可选，自己填路径）
 *   6) ~/.dsh/style-packs/<domain>/<pack>/rules.json（结构化风格准则）
 *   7) 插件配置快照：在 CONFIG_SNAPSHOTS 里填需要收的配置文件（默认空）
 *
 * 产出：
 *   ~/.dsh/rules/harvest/index.json           来源清单（每源：路径/hash/字节/candidates 数）
 *   ~/.dsh/rules/harvest/<slug>.json          单源候选（行号 + 原文）
 *   ~/.dsh/rules/coverage.json                覆盖账（每个来源的 ingested/ignored 状态）
 *
 * 用法: node scripts/harvest.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const DSH_DIR = path.join(HOME, '.dsh')
export const HARVEST_DIR = path.join(DSH_DIR, 'rules', 'harvest')
const PROFILE = path.join(DSH_DIR, 'profiles', 'desktop')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const slugOf = (p) => p.replace(HOME, '~').replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.~-]/g, '_').slice(-120)

// 候选判定：具体、可执行的句子（有强制词/数字/格式/路径/步骤门禁）
const SIGNAL = /(必须|禁止|不要|不得|应|优先|默认|只能|只能|总是|永远|至少|最多|不超过|≤|≥|<|>|\d+\s*(px|pt|px|%|字|页|分钟|秒|行|列|个|层|维|次|dpi|fps)|格式|目录|命名|模板|校验|验证|先|再|然后|门禁|检查|confirmation|must|never|always|required|prefer)/i
const BOILER = /^(license|授权|版权|本文件|这个文件|see also|参考|更多信息|更新日志|版本|changelog|table of contents|目录$)/i

export function extractCandidates(text, { minLen = 12, maxLen = 320, maxPerSource = 80 } = {}) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim()
    if (line.length < minLen || line.length > maxLen) continue
    if (/^#|^\|/.test(line)) continue
    if (BOILER.test(line)) continue
    if (!SIGNAL.test(line)) continue
    if (/https?:\/\/[^\s]+$/.test(line) && line.length < 30) continue
    out.push({ line: i + 1, text: line })
    if (out.length >= maxPerSource) break
  }
  return out
}

function addSource(sources, { kind, file, text, extra = {} }) {
  if (!text) return
  const candidates = extractCandidates(text)
  const entry = {
    kind,
    file,
    slug: slugOf(file),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha1: sha1(text),
    candidates: candidates.length,
    ...extra,
  }
  sources.push(entry)
  fs.mkdirSync(HARVEST_DIR, { recursive: true })
  fs.writeFileSync(path.join(HARVEST_DIR, entry.slug + '.json'), JSON.stringify({ ...entry, items: candidates }, null, 1), 'utf8')
  return entry
}

export function discover() {
  const sources = []

  // 1) 用户级技能
  const userSkills = path.join(DSH_DIR, 'skills')
  for (const d of fs.readdirSync(userSkills, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dir = path.join(userSkills, d.name)
    const skill = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(skill)) {
      addSource(sources, { kind: 'skill-noskill', file: dir, text: fs.readdirSync(dir).join('\n'), extra: { note: '无 SKILL.md（可能是脚本目录）' } })
      continue
    }
    const text = fs.readFileSync(skill, 'utf8')
    const refs = []
    const walk = (d2, depth = 0) => {
      if (depth > 3) return
      for (const e of fs.readdirSync(d2, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const p = path.join(d2, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else if (/\.(md|mjs|js|py|ps1|sh|json|yml|yaml)$/i.test(e.name)) refs.push(path.relative(dir, p))
      }
    }
    try { walk(dir) } catch {}
    addSource(sources, { kind: 'skill', file: skill, text, extra: { skill: d.name, refs: refs.length, refFiles: refs.slice(0, 40) } })
  }

  // 2) 插件捆绑技能（递归找 SKILL.md，含 @scope 包与 references 子模块）
  const pluginsDir = path.join(PROFILE, 'node_modules')
  const pluginDirs = []
  for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      for (const sub of fs.readdirSync(path.join(pluginsDir, e.name), { withFileTypes: true })) {
        if (sub.isDirectory()) pluginDirs.push(path.join(pluginsDir, e.name, sub.name))
      }
    } else if (e.isDirectory()) pluginDirs.push(path.join(pluginsDir, e.name))
  }
  const seenSkill = new Set()
  for (const pdir of pluginDirs) {
    let pkgJson = null
    try { pkgJson = JSON.parse(read(path.join(pdir, 'package.json'))) } catch {}
    const found = []
    const walkSkills = (d, depth = 0) => {
      if (depth > 4) return
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const p = path.join(d, e.name)
        if (e.isDirectory()) walkSkills(p, depth + 1)
        else if (e.name === 'SKILL.md') found.push(p)
      }
    }
    walkSkills(path.join(pdir, 'skills'))
    for (const skill of found) {
      if (seenSkill.has(skill)) continue
      seenSkill.add(skill)
      addSource(sources, {
        kind: 'bundled-skill',
        file: skill,
        text: fs.readFileSync(skill, 'utf8'),
        extra: { plugin: pkgJson?.name ?? path.basename(pdir), skill: path.basename(path.dirname(skill)) },
      })
    }
  }

  // 3) AGENTS.md
  const agents = path.join(DSH_DIR, 'AGENTS.md')
  const agentsText = read(agents)
  if (agentsText) {
    const manual = agentsText.split('<!-- dsh-rules:begin')[0]
    addSource(sources, { kind: 'agents', file: agents, text: manual })
  }

  // 4) EXPERIENCE.md
  const exp = path.join(DSH_DIR, 'EXPERIENCE.md')
  const expText = read(exp)
  if (expText) addSource(sources, { kind: 'experience', file: exp, text: expText })

  // 5) style-packs 的 rules.json
  const sp = path.join(DSH_DIR, 'style-packs')
  if (fs.existsSync(sp)) {
    const walkSp = (d, depth = 0) => {
      if (depth > 4) return
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walkSp(p, depth + 1)
        else if (e.name === 'rules.json') {
          let rules = {}
          try { rules = JSON.parse(read(p)) } catch {}
          const text = Object.entries(rules).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
          addSource(sources, { kind: 'style-pack', file: p, text })
        }
      }
    }
    walkSp(sp)
  }

  // 8) DSH runtime 内置技能（office-skills 等，位于安装目录而不是用户技能目录）
  const runtimeSkills = process.env.DSH_RUNTIME_SKILLS || 'D:\\DSH\\resources\\runtime\\office-skills'
  if (fs.existsSync(runtimeSkills)) {
    for (const d of fs.readdirSync(runtimeSkills, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const skill = path.join(runtimeSkills, d.name, 'SKILL.md')
      if (!fs.existsSync(skill)) continue
      addSource(sources, { kind: 'builtin-skill', file: skill, text: fs.readFileSync(skill, 'utf8'), extra: { origin: 'runtime', skill: d.name } })
    }
  }

  // 9) 从 app.asar 抽出的内置技能
  const asarDir = path.join(HARVEST_DIR, 'asar')
  if (fs.existsSync(asarDir)) {
    for (const f of fs.readdirSync(asarDir).filter((x) => x.endsWith('.md'))) {
      const file = path.join(asarDir, f)
      addSource(sources, { kind: 'builtin-skill', file, text: read(file), extra: { origin: 'asar', skill: f.replace(/\.md$/, '') } })
    }
  }

  // 7) 插件配置快照（可选：把需要纳入规则的插件配置文件填进这个数组，如 ['my-plugin.config.json']）
  for (const cfg of []) {
    const p = path.join(DSH_DIR, cfg)
    const text = read(p)
    if (text) addSource(sources, { kind: 'plugin-config', file: p, text })
  }

  // index + coverage 初始化
  fs.mkdirSync(HARVEST_DIR, { recursive: true })
  const index = {
    generatedAt: new Date().toISOString(),
    counts: { total: sources.length, byKind: sources.reduce((a, s) => { a[s.kind] = (a[s.kind] ?? 0) + 1; return a }, {}), candidates: sources.reduce((a, s) => a + s.candidates, 0) },
    sources,
  }
  fs.writeFileSync(path.join(HARVEST_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
  return index
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const index = discover()
  if (process.argv.includes('--json')) console.log(JSON.stringify(index.counts, null, 2))
  else {
    console.log(`来源 ${index.counts.total} 个（${Object.entries(index.counts.byKind).map(([k, v]) => k + '=' + v).join(' ')}），候选行 ${index.counts.candidates} 条`)
    for (const s of index.sources) console.log(`  [${s.kind}] ${s.file.replace(HOME, '~')}  → ${s.candidates} 候选${s.skill ? '（' + s.skill + '）' : ''}`)
  }
  // 采集即登记：把这次扫到的来源全部记为已采集到台账（来源闸口 sources.json）
  try {
    const { recordSources, discoverSources } = await import('../lib/sources.js')
    const ids = discoverSources().map((s) => s.id)
    const r = recordSources({ harvested: ids, note: 'harvest.mjs run ' + new Date().toISOString().slice(0, 10) })
    console.log(`来源台账已登记：${r.recorded} 个来源（标记已采集 ${r.harvested}）`)
  } catch (e) {
    console.log('来源台账登记失败（不影响本次采集）：' + (e?.message ?? e))
  }
}
