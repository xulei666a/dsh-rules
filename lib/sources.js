/**
 * dsh-rules · 来源闸口（source gate）v2
 *
 * 目标：把「我学了一个新技能 / 装了一个插件」自动登记下来，且**不假设**安装位置。
 *
 * 覆盖范围：
 *   1) 用户技能            ~/.dsh/skills/<名>/
 *   2) 工作区技能          <workspace>/.dsh/skills/<名>/
 *   3) 插件市场装的插件    ~/.dsh/profiles/<profile>/node_modules/<包>[/skills|/任意深度 SKILL.md]
 *      共享 runtime 包      ~/.dsh/profiles/node_modules/<包>/...
 *      —— 包含 link:/junction 的插件（会按真实路径去重）
 *   4) REA 官方技能        ~/.agents/skills/<名>/
 *   5) runtime 内置技能    由 process.resourcesPath / DSH_RUNTIME_SKILLS / 常见相对路径自动探测
 *   6) 风格包              ~/.dsh/style-packs/<domain>/<pack>/
 *   7) 配置文件            AGENTS.md / EXPERIENCE.md / persona
 *   8) 用户自定义根         ~/.dsh/rules/sources.config.json 的 extraRoots（任意位置）
 *
 * 判断：每个来源算指纹（文件数+最新 mtime）→ 与台账 sources.json 比：new / changed / removed。
 * 只登记提醒，不自动采集（自动抓别人技能的文字容易引入过时/冲突内容）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
export const DSH_DIR = process.env.DSH_HOME || path.join(HOME, '.dsh')
const RULES_DIR = process.env.DSH_RULES_DIR || path.join(DSH_DIR, 'rules')
export const SOURCES_FILE = path.join(RULES_DIR, 'sources.json')
export const SOURCES_CONFIG = path.join(RULES_DIR, 'sources.config.json')

/* ---------------- 基础工具 ---------------- */
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const listDirs = (p) => {
  let ents = []
  try { ents = fs.readdirSync(p, { withFileTypes: true }) } catch { return [] }
  // 注意：Windows junction / macOS symlink 在 withFileTypes 里不是 directory，必须 stat 兜底
  return ents.filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(p, e.name)))).map((e) => e.name)
}
const realpath = (p) => { try { return fs.realpathSync(p) } catch { return p } }
const statOr = (p) => { try { return fs.statSync(p) } catch { return null } }

function dirFingerprint(dir) {
  let files = 0, newest = 0
  const walk = (d, depth) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      let dirLike = e.isDirectory()
      if (e.isSymbolicLink()) dirLike = isDir(p)
      if (dirLike) { if (depth < 2) walk(p, depth + 1) }
      else {
        if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue
        files += 1
        const st = statOr(p)
        if (st && st.mtimeMs > newest) newest = st.mtimeMs
      }
    }
  }
  walk(dir, 0)
  return `${files}:${Math.round(newest)}`
}

/* ---------------- 配置：用户自定义根 / 忽略项 ---------------- */
export function loadSourceConfig() {
  const def = { version: 1, extraRoots: [], ignore: [] }
  try {
    const j = JSON.parse(fs.readFileSync(SOURCES_CONFIG, 'utf8').replace(/^\uFEFF/, ''))
    return {
      version: 1,
      extraRoots: Array.isArray(j.extraRoots) ? j.extraRoots.filter((r) => r && r.path).map((r) => ({ kind: String(r.kind || 'custom'), path: String(r.path) })) : [],
      ignore: Array.isArray(j.ignore) ? j.ignore.map(String) : [],
    }
  } catch { return def }
}
export function saveSourceConfig(cfg) {
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(SOURCES_CONFIG, JSON.stringify({ version: 1, ...cfg }, null, 2) + '\n', 'utf8')
}
export function addRoot(kind, p) {
  const cfg = loadSourceConfig()
  const abs = path.resolve(p)
  if (!cfg.extraRoots.some((r) => path.resolve(r.path) === abs)) cfg.extraRoots.push({ kind: String(kind || 'custom'), path: abs })
  saveSourceConfig(cfg)
  invalidateSourceCache()
  return cfg.extraRoots
}
export function addIgnore(pattern) {
  const cfg = loadSourceConfig()
  if (!cfg.ignore.includes(pattern)) cfg.ignore.push(pattern)
  saveSourceConfig(cfg)
  invalidateSourceCache()
  return cfg.ignore
}

/* ---------------- 根目录解析（跨平台，不写死盘符） ---------------- */
function runtimeSkillCandidates() {
  const out = []
  if (process.env.DSH_RUNTIME_SKILLS) for (const p of process.env.DSH_RUNTIME_SKILLS.split(path.delimiter)) if (p) out.push(path.resolve(p))
  const resources = process.env.DSH_RESOURCES || process.resourcesPath || ''
  if (resources) {
    out.push(path.join(resources, 'runtime', 'office-skills'))
    out.push(path.join(resources, 'app.asar.unpacked', 'runtime', 'office-skills'))
  }
  const exeDir = process.execPath ? path.dirname(process.execPath) : ''
  if (exeDir) {
    out.push(path.join(exeDir, 'resources', 'runtime', 'office-skills'))
    out.push(path.join(exeDir, '..', 'resources', 'runtime', 'office-skills'))
  }
  out.push(path.join(DSH_DIR, 'dsh-runtimes', 'office-skills'))
  return out
}

/** 所有已存在的来源根 */
export function sourceRoots() {
  const roots = []
  const seen = new Set()
  const push = (kind, dir) => {
    if (!dir || !isDir(dir)) return
    const rp = realpath(dir)
    const k = kind + '::' + rp
    if (seen.has(k)) return
    seen.add(k)
    roots.push({ kind, dir, real: rp })
  }
  push('user-skill', path.join(DSH_DIR, 'skills'))
  const ws = process.env.DSH_WORKSPACE || process.cwd()
  push('workspace-skill', path.join(ws, '.dsh', 'skills'))

  // profiles：<profile>/node_modules 与共享的 profiles/node_modules
  const profilesDir = path.join(DSH_DIR, 'profiles')
  const profiles = listDirs(profilesDir)
  for (const p of profiles) {
    if (!p.startsWith('node_modules')) push('profile-pkg', path.join(profilesDir, p, 'node_modules'))
  }
  push('profile-pkg', path.join(profilesDir, 'node_modules'))
  // 工作区自己的 node_modules（项目级插件）
  push('workspace-pkg', path.join(ws, 'node_modules'))

  push('agents-skill', path.join(HOME, '.agents', 'skills'))
  for (const r of runtimeSkillCandidates()) push('runtime-skill', r)
  push('style-pack', path.join(DSH_DIR, 'style-packs'))
  for (const r of loadSourceConfig().extraRoots) push(r.kind || 'custom', r.path)
  return roots
}

/** 包目录里找技能：<pkg>/skills/<名> 或任意深度 SKILL.md 的父目录 */
function skillsInPackage(pkgDir) {
  const found = new Map() // realpath -> name
  const direct = path.join(pkgDir, 'skills')
  if (isDir(direct)) for (const name of listDirs(direct)) found.set(realpath(path.join(direct, name)), name)
  const walk = (d, depth) => {
    if (depth > 4) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(d, e.name)
      let dirLike = e.isDirectory() || (e.isSymbolicLink() && isDir(p))
      if (dirLike) { walk(p, depth + 1); continue }
      if (e.name === 'SKILL.md') found.set(realpath(path.dirname(p)), path.basename(path.dirname(p)))
    }
  }
  walk(pkgDir, 0)
  return found
}

/** 扫描当前来源（带 30s 缓存：profile 里包很多，别每次 UI 刷新都全盘走一遍） */
let _discoverCache = { at: 0, list: null }
export function discoverSources({ force = false } = {}) {
  if (!force && _discoverCache.list && Date.now() - _discoverCache.at < 30000) return _discoverCache.list
  const cfg = loadSourceConfig()
  const ignored = (id, p) => cfg.ignore.some((pat) => id.includes(pat) || p.includes(pat))
  const out = []

  for (const { kind, dir, real } of sourceRoots()) {
    if (kind === 'style-pack') {
      for (const domain of listDirs(dir)) for (const pack of listDirs(path.join(dir, domain))) {
        const p = path.join(dir, domain, pack)
        const id = `style-pack:${domain}/${pack}`
        if (!ignored(id, p)) out.push({ id, kind, name: `${domain}/${pack}`, path: p, fingerprint: dirFingerprint(p) })
      }
      continue
    }
    if (kind === 'profile-pkg' || kind === 'workspace-pkg') {
      for (const pkg of listDirs(dir)) {
        const pkgDirs = pkg.startsWith('@') ? listDirs(path.join(dir, pkg)).map((s) => path.join(pkg, s)) : [pkg]
        for (const relPkg of pkgDirs) {
          const pkgDir = path.join(dir, relPkg)
          const skills = skillsInPackage(pkgDir)
          for (const [skillPath, name] of skills) {
            const id = `plugin-skill:${relPkg.replace(/\\/g, '/')}/${name}`
            if (!ignored(id, skillPath)) out.push({ id, kind: 'plugin-skill', name: `${relPkg}/${name}`, path: skillPath, fingerprint: dirFingerprint(skillPath) })
          }
        }
      }
      continue
    }
    for (const name of listDirs(dir)) {
      const p = path.join(dir, name)
      const id = `${kind}:${name}`
      if (ignored(id, p)) continue
      out.push({ id, kind, name, path: p, fingerprint: dirFingerprint(p) })
    }
  }

  // 配置文件类来源（路径可被 extraRoots 之外单独存在，按需忽略）
  const files = [
    ['agents', 'AGENTS.md', path.join(DSH_DIR, 'AGENTS.md')],
    ['experience', 'EXPERIENCE.md', path.join(DSH_DIR, 'EXPERIENCE.md')],
    ['persona', 'bili-whale persona', path.join(HOME, '.bili-ai', 'persona.md')],
  ]
  for (const [kind, name, f] of files) {
    if (!isFile(f)) continue
    const id = `${kind}:${name}`
    if (ignored(id, f)) continue
    const st = statOr(f)
    out.push({ id, kind, name, path: f, fingerprint: `${st.size}:${Math.round(st.mtimeMs)}` })
  }
  const list = out.sort((a, b) => a.id.localeCompare(b.id))
  _discoverCache = { at: Date.now(), list }
  return list
}
/** 清缓存（改配置/登记后调用） */
export function invalidateSourceCache() { _discoverCache = { at: 0, list: null } }

/* ---------------- 台账 ---------------- */
export function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return { version: j.version || 1, updatedAt: j.updatedAt || null, sources: j.sources || {} }
  } catch { return { version: 1, updatedAt: null, sources: {} } }
}
export function saveLedger(ledger) {
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(SOURCES_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sources: ledger.sources }, null, 2) + '\n', 'utf8')
}

export function checkSources({ force = true } = {}) {
  const ledger = loadLedger()
  const current = discoverSources({ force })   // 默认实时；UI 高频调用可传 force:false 用 30s 缓存
  const newOnes = [], changed = [], same = []
  for (const s of current) {
    const prev = ledger.sources[s.id]
    if (!prev) newOnes.push(s)
    else if (prev.fingerprint !== s.fingerprint) changed.push({ ...s, prevFingerprint: prev.fingerprint, harvestedAt: prev.harvestedAt })
    else same.push(s)
  }
  const currentIds = new Set(current.map((s) => s.id))
  const removed = Object.entries(ledger.sources).filter(([id]) => !currentIds.has(id)).map(([id, v]) => ({ id, ...v }))
  return { total: current.length, new: newOnes, changed, removed, unchanged: same.length, ledgerUpdatedAt: ledger.updatedAt }
}

export function recordSources({ harvested = [], note = '' } = {}) {
  const ledger = loadLedger()
  const current = discoverSources({ force: true })
  const now = new Date().toISOString()
  const keep = new Set(current.map((s) => s.id))
  // 迁移旧 id（v0.15 的 plugin-skill:<技能名> → v0.16 的 plugin-skill:<包>/<技能名>）
  const byTail = new Map()
  for (const s of current) if (s.kind === 'plugin-skill') byTail.set(s.name.split('/').pop(), s.id)
  for (const [id, v] of Object.entries(ledger.sources)) {
    if (keep.has(id) || !id.startsWith('plugin-skill:')) continue
    const tail = id.slice('plugin-skill:'.length)
    const to = byTail.get(tail)
    if (to) {
      const target = ledger.sources[to]
      if (!target) ledger.sources[to] = { ...v, path: current.find((s) => s.id === to)?.path || v.path }
      else if (v.firstSeen && (!target.firstSeen || v.firstSeen < target.firstSeen)) target.firstSeen = v.firstSeen
      delete ledger.sources[id]
    }
  }
  for (const s of current) {
    const prev = ledger.sources[s.id]
    const isHarvested = harvested.includes(s.id)
    ledger.sources[s.id] = {
      kind: s.kind, name: s.name, path: s.path, fingerprint: s.fingerprint,
      firstSeen: prev?.firstSeen || now, lastSeen: now,
      harvestedAt: isHarvested ? now : (prev?.harvestedAt || null),
      status: isHarvested ? 'harvested' : (prev?.status || 'pending'),
      note: note || prev?.note || '',
    }
  }
  // 已消失的来源保留一段时间（方便查"这个技能删了但规则还在"），超过 30 天清掉
  for (const [id, v] of Object.entries(ledger.sources)) {
    if (keep.has(id)) continue
    const ageDays = (Date.now() - new Date(v.lastSeen || 0).getTime()) / 86400000
    if (ageDays > 30) delete ledger.sources[id]
    else ledger.sources[id].status = 'stale'
  }
  saveLedger(ledger)
  invalidateSourceCache()
  return { recorded: current.length, harvested: harvested.length }
}

export function harvestPlan() {
  const r = checkSources()
  return {
    new: r.new.map((s) => ({ id: s.id, kind: s.kind, name: s.name, path: s.path })),
    changed: r.changed.map((s) => ({ id: s.id, kind: s.kind, name: s.name, path: s.path, harvestedAt: s.harvestedAt })),
    removed: r.removed.map((s) => ({ id: s.id, name: s.name, path: s.path })),
    total: r.total,
    suggested: 'node scripts/harvest.mjs  →  node scripts/merge-proposals.mjs  →  rules_coverage op=review',
  }
}

/** 给 UI/CLI 看的根目录清单 */
export function sourceRootSummary() {
  const cfg = loadSourceConfig()
  return {
    dshDir: DSH_DIR,
    roots: sourceRoots().map((r) => ({ kind: r.kind, path: r.dir, real: r.real })),
    extraRoots: cfg.extraRoots,
    ignore: cfg.ignore,
    configFile: SOURCES_CONFIG,
  }
}
