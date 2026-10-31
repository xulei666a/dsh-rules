/**
 * dsh-rules · 分类树（v0.4）
 *
 * 模型：多套「分类方案（scheme）」→ 每套是一棵任意深度的树。
 * - 节点（node）：{ id, title, desc, select?, children[] }
 * - 规则归属：每套方案里，一条规则只属于**一个**节点（不能复制）：
 *     1) 显式移动记录 placements[ruleKey] = nodeId（拖拽/移动时写入，可指向 null=未分类）
 *     2) 否则按 DFS 顺序找第一个 select 命中的节点（内置默认方案用选择器自动归类）
 *     3) 都没命中 → 未分类
 * - 可移动：节点换父级（不能移进自己的子孙）、规则换节点；纯显示层，不动真实规则文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULES_DIR, loadRules } from './store.js'
import { tagsOfStrict } from './tags.js'

export const SCHEMES_FILE = path.join(RULES_DIR, 'groups.json')
export const UNDO_FILE = path.join(RULES_DIR, 'groups.undo.json')
const nowISO = () => new Date().toISOString()
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'node'
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const sel = (text) => text // 文档用：节点 select 形状 { categories?, tags?, keys?, keyPrefixes? }

/** 内置默认方案：4 个大类，小类用选择器自动归类 */
const DEFAULT_SCHEME = {
  id: 'default',
  title: '默认分类',
  desc: '基准分类：产出交付 / 记忆与底线 / 工作方式 / 工具与环境 + 待复核；可让助手改成自己的分法',
  builtin: true,
  nodes: [
    {
      id: 'cat-inbox', title: '待复核', desc: '从技能/插件/收集来的准则，先放这里，确认后再归到正式分类', children: [
        { id: 'inbox-pending', title: '待确认', select: { status: ['pending'] } },
      ],
    },
    {
      id: 'cat-output', title: '产出交付', desc: '要交付给别人看的成品', children: [
        { id: 'out-slides', title: '演示文稿', select: { tags: ['ppt'] } },
        { id: 'out-docs', title: '文档表格', select: { tags: ['office'] } },
        { id: 'out-writing', title: '论文报告', select: { tags: ['paper', 'report'] } },
        { id: 'out-visual', title: '图表可视化', select: { tags: ['diagram'] } },
        { id: 'out-media', title: '图片视频', select: { tags: ['image', 'video', 'animation'] } },
        { id: 'out-3d', title: '3D 与建模', select: { tags: ['blender'] } },
      ],
    },
    {
      id: 'cat-safe', title: '记忆与底线', desc: '长期记忆、维护纪律与硬红线', children: [
        { id: 'safe-memory', title: '记忆与经验', select: { tags: ['memory'] } },
        { id: 'safe-rules', title: '安全与权限', select: { categories: ['safety'], tags: ['safety'] } },
      ],
    },
    {
      id: 'cat-work', title: '工作方式', desc: '怎么干活、怎么验收（workflow 类别按关键词细分）', children: [
        { id: 'work-comm', title: '沟通与回复', select: { keywords: ['回复', '汇报', '沟通', '简洁', '结论先行', '中文回答', '措辞'] } },
        { id: 'work-proof', title: '验证与证据', select: { keywords: ['证据', '验证', '校验', '自查', '复核', '测试', '核对', '引用'] } },
        { id: 'work-change', title: '变更与审计', select: { keywords: ['改动', '备份', '变更', '审计', '批量', '回滚', '迁移'] } },
        { id: 'work-memory', title: '记忆维护', select: { keywords: ['记忆', 'AGENTS', '经验库', '技能更新', '主动维护'] } },
        { id: 'work-exec', title: '执行与流程', select: { categories: ['workflow'] } },
      ],
    },
    {
      id: 'cat-env', title: '工具与环境', desc: '装什么、放哪、花多少钱', children: [
        { id: 'env-paths', title: '安装与路径', select: { categories: ['paths', 'install'], tags: ['install'] } },
        { id: 'env-tools', title: '工具选型', select: { categories: ['tools'] } },
        { id: 'env-skills', title: '技能与插件', select: { categories: ['skill'], tags: ['skill'] } },
        { id: 'env-cost', title: '模型与成本', select: { categories: ['model'], tags: ['model'] } },
      ],
    },
  ],
  placements: {},
}

function walk(nodes, fn, parent = null, depth = 0) {
  for (const n of nodes ?? []) {
    fn(n, parent, depth)
    if (n.children?.length) walk(n.children, fn, n, depth + 1)
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o))

function normalizeScheme(s) {
  const out = { id: String(s.id ?? uid('scheme')), title: String(s.title ?? '未命名方案'), desc: String(s.desc ?? ''), builtin: Boolean(s.builtin), nodes: [], placements: {}, order: {} }
  const normNode = (n) => {
    const node = { id: String(n.id ?? uid('n')), title: String(n.title ?? '未命名'), desc: String(n.desc ?? '') }
    if (n.select && typeof n.select === 'object') {
      node.select = {}
      for (const k of ['categories', 'tags', 'keys', 'keyPrefixes', 'keywords', 'status']) if (Array.isArray(n.select[k]) && n.select[k].length) node.select[k] = n.select[k].map(String)
      if (!Object.keys(node.select).length) delete node.select
    }
    if (Array.isArray(n.children) && n.children.length) node.children = n.children.map(normNode)
    return node
  }
  out.nodes = (s.nodes ?? []).map(normNode)
  out.placements = s.placements && typeof s.placements === 'object' ? { ...s.placements } : {}
  // 规则在同一节点内的显示顺序（拖拽换位用）：{ "<nodeId|__root__>": [key, ...] }
  out.order = {}
  if (s.order && typeof s.order === 'object') for (const [k, v] of Object.entries(s.order)) if (Array.isArray(v)) out.order[k] = v.map(String)
  return out
}

/** 读文件；兼容 v1（旧平铺分组）→ 迁移成「个人分组」方案 + 保证默认方案存在 */
export function loadSchemes() {
  fs.mkdirSync(RULES_DIR, { recursive: true })
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(SCHEMES_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch {}
  let schemes = []
  if (raw && raw.version === 2 && Array.isArray(raw.schemes)) {
    schemes = raw.schemes.map(normalizeScheme)
  } else if (raw && Array.isArray(raw.groups)) {
    // v1 → v2：旧自建平铺分组变成一个方案的一层节点
    const nodes = raw.groups.map((g) => ({ id: g.id || slug(g.title), title: g.title || g.id, desc: g.desc || '', select: g.select || {} }))
    if (nodes.length) schemes.push(normalizeScheme({ id: 'personal', title: '个人分组（从旧版迁移）', desc: '旧版平铺分组 → 分类树', nodes }))
  }
  if (!schemes.some((s) => s.id === DEFAULT_SCHEME.id)) schemes.unshift(clone(DEFAULT_SCHEME))
  else schemes = schemes.map((s) => (s.id === DEFAULT_SCHEME.id ? { ...clone(DEFAULT_SCHEME), ...s, builtin: true } : s))
  saveSchemes(schemes, { silent: true })
  return schemes
}

export function saveSchemes(schemes, { silent = false } = {}) {
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(SCHEMES_FILE, JSON.stringify({ version: 2, updatedAt: nowISO(), schemes }, null, 2) + '\n', 'utf8')
  if (!silent) return { saved: true }
}

export const findNode = (nodes, id) => {
  let hit = null
  walk(nodes, (n) => { if (n.id === id) hit = n })
  return hit
}
export const flattenNodes = (nodes) => {
  const out = []
  walk(nodes, (n, parent, depth) => out.push({ node: n, parent, depth }))
  return out
}
const findParentList = (nodes, id, list = nodes, parent = null) => {
  for (const n of list) {
    if (n.id === id) return { list, parent, node: n }
    if (n.children) { const r = findParentList(n.children, id, n.children, n); if (r) return r }
  }
  return null
}
const isDescendant = (node, id) => {
  let hit = false
  walk(node.children ?? [], (n) => { if (n.id === id) hit = true })
  return hit
}

/** 规则 → 节点分配（每规则至多一个节点） */
export function computeAssignments(scheme, rules = loadRules()) {
  const order = flattenNodes(scheme.nodes).map((x) => x.node)
  const placements = scheme.placements ?? {}
  const map = new Map() // ruleKey -> nodeId|null
  for (const r of rules) {
    if (Object.prototype.hasOwnProperty.call(placements, r.key)) { map.set(r.key, placements[r.key]); continue }
    let hit = null
    for (const n of order) {
      const s = n.select
      if (!s) continue
      if (s.keys?.includes(r.key)) { hit = n.id; break }
      if (s.keyPrefixes?.some((p) => r.key.startsWith(p))) { hit = n.id; break }
      if (s.categories?.includes(r.category)) { hit = n.id; break }
      if (s.tags?.length) {
        const t = tagsOfStrict(r)
        if (s.tags.some((x) => t.includes(x))) { hit = n.id; break }
      }
      if (s.status?.length && s.status.includes(r.status)) { hit = n.id; break }
      if (s.keywords?.length) {
        const hay = `${r.key} ${r.title || ''} ${r.value || ''}`
        if (s.keywords.some((k) => hay.includes(k))) { hit = n.id; break }
      }
    }
    map.set(r.key, hit)
  }
  return map
}

/** 树 + 计数（own：自身；total：含子孙）；order 为节点内规则显示顺序 */
export function schemeView(scheme, rules = loadRules()) {
  const assign = computeAssignments(scheme, rules)
  const byNode = new Map()
  for (const [k, v] of assign) if (v) byNode.set(v, (byNode.get(v) ?? 0) + 1)
  const unassigned = [...assign.values()].filter((v) => v === null).length
  const build = (nodes) => (nodes ?? []).map((n) => {
    const children = build(n.children)
    const own = byNode.get(n.id) ?? 0
    const total = own + children.reduce((a, c) => a + c.total, 0)
    return { id: n.id, title: n.title, desc: n.desc ?? '', select: n.select ?? null, own, total, children }
  })
  return { id: scheme.id, title: scheme.title, desc: scheme.desc ?? '', builtin: Boolean(scheme.builtin), roots: build(scheme.nodes), unassigned, total: rules.length, assigned: rules.length - unassigned, order: { ...(scheme.order ?? {}) } }
}

export function listSchemes(rules = loadRules()) {
  return loadSchemes().map((s) => {
    const view = schemeView(s, rules)
    return { id: view.id, title: view.title, desc: view.desc, builtin: view.builtin, total: view.total, unassigned: view.unassigned }
  })
}

export function getScheme(id) {
  const schemes = loadSchemes()
  return schemes.find((s) => s.id === id) ?? schemes[0]
}

function mutate(fn, { schemeId } = {}) {
  const schemes = loadSchemes()
  const idx = schemeId ? schemes.findIndex((s) => s.id === schemeId) : 0
  if (idx < 0) throw new Error('方案不存在：' + schemeId)
  saveUndo(schemes[idx])
  fn(schemes[idx], schemes)
  saveSchemes(schemes)
  return schemes[idx]
}

/* ---------------- 撤回（多步）：改结构前把该方案快照压栈到 groups.undo.json ---------------- */
const UNDO_LIMIT = 30
function readUndoStack() {
  try {
    const raw = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'))
    if (Array.isArray(raw?.stack)) return raw.stack.filter((x) => x && x.scheme && x.scheme.id)
    if (raw?.scheme?.id) return [{ at: raw.at, scheme: raw.scheme }]   // 兼容旧的单步快照
  } catch {}
  return []
}
function writeUndoStack(stack) {
  try {
    fs.mkdirSync(RULES_DIR, { recursive: true })
    fs.writeFileSync(UNDO_FILE, JSON.stringify({ stack }), 'utf8')
  } catch {}
}
export function saveUndo(scheme) {
  const stack = readUndoStack()
  stack.push({ at: nowISO(), scheme: clone(scheme) })
  while (stack.length > UNDO_LIMIT) stack.shift()
  writeUndoStack(stack)
}
export function hasUndo() { return readUndoStack().length > 0 }
export function undoCount() { return readUndoStack().length }
export function undoLast() {
  const stack = readUndoStack()
  const snap = stack.pop()
  if (!snap?.scheme?.id) throw new Error('没有可撤回的上一步')
  const schemes = loadSchemes()
  const i = schemes.findIndex((s) => s.id === snap.scheme.id)
  if (i < 0) throw new Error('要撤回的方案已不存在')
  schemes[i] = normalizeScheme({ ...snap.scheme, builtin: schemes[i].builtin })
  saveSchemes(schemes)
  writeUndoStack(stack)
  return { undone: schemes[i].id, title: schemes[i].title, at: snap.at, remaining: stack.length }
}

export function createScheme({ title, desc = '' } = {}) {
  if (!title || !String(title).trim()) throw new Error('方案必须有名称')
  const schemes = loadSchemes()
  const id = slug(title) + (schemes.some((s) => s.id === slug(title)) ? '-' + Date.now().toString(36) : '')
  const s = normalizeScheme({ id, title: String(title).trim(), desc, nodes: [], placements: {} })
  schemes.push(s)
  saveSchemes(schemes)
  return s
}

export function renameScheme(id, { title, desc } = {}) {
  return mutate((s) => { if (title) s.title = String(title).trim(); if (desc !== undefined) s.desc = String(desc) }, { schemeId: id })
}

export function deleteScheme(id) {
  const schemes = loadSchemes()
  const s = schemes.find((x) => x.id === id)
  if (!s) throw new Error('方案不存在：' + id)
  if (s.builtin) throw new Error('内置方案不能删除')
  saveUndo(s)
  saveSchemes(schemes.filter((x) => x.id !== id))
  return { deleted: id }
}

/** 新增节点：parentId 为空=顶级；id/title 可指定（默认方案重置时用） */
export function addNode({ schemeId, parentId = null, title, desc = '', select, id } = {}) {
  if (!title || !String(title).trim()) throw new Error('节点必须有名称')
  const node = { id: id || uid(slug(title)), title: String(title).trim(), desc }
  if (select && Object.keys(select).length) node.select = select
  mutate((s) => {
    if (parentId) { const p = findNode(s.nodes, parentId); if (!p) throw new Error('父节点不存在：' + parentId); (p.children ??= []).push(node) }
    else (s.nodes ??= []).push(node)
  }, { schemeId })
  return node
}

export function renameNode({ schemeId, nodeId, title, desc } = {}) {
  let node = null
  mutate((s) => {
    node = findNode(s.nodes, nodeId)
    if (!node) throw new Error('节点不存在：' + nodeId)
    if (title) node.title = String(title).trim()
    if (desc !== undefined) node.desc = desc
  }, { schemeId })
  return node
}

/** 删除节点（连同子树）；被删节点上的规则归属记录一并清除（回到自动归类/未分类） */
export function deleteNode({ schemeId, nodeId } = {}) {
  let removed = null
  mutate((s) => {
    const loc = findParentList(s.nodes, nodeId)
    if (!loc) throw new Error('节点不存在：' + nodeId)
    const removedIds = new Set([nodeId])
    walk(loc.node.children ?? [], (n) => removedIds.add(n.id))
    loc.list.splice(loc.list.indexOf(loc.node), 1)
    for (const [k, v] of Object.entries(s.placements ?? {})) if (removedIds.has(v)) delete s.placements[k]
    if (s.order) for (const id of removedIds) delete s.order[id]
    removed = [...removedIds]
  }, { schemeId })
  return { removed }
}

/** 移动节点：parentId 为空=移到顶级；不能移进自己或自己的子孙 */
export function moveNode({ schemeId, nodeId, parentId = null, index = null } = {}) {
  mutate((s) => {
    const loc = findParentList(s.nodes, nodeId)
    if (!loc) throw new Error('节点不存在：' + nodeId)
    if (parentId) {
      if (parentId === nodeId || isDescendant(loc.node, parentId)) throw new Error('不能把节点移进自己的子级')
      const target = findNode(s.nodes, parentId)
      if (!target) throw new Error('目标节点不存在：' + parentId)
    }
    loc.list.splice(loc.list.indexOf(loc.node), 1)
    const dest = parentId ? (findNode(s.nodes, parentId).children ??= []) : s.nodes
    if (index === null || index === undefined || index < 0 || index > dest.length) dest.push(loc.node)
    else dest.splice(index, 0, loc.node)
  }, { schemeId })
  return { moved: nodeId, parentId }
}

/* 节点内规则顺序：用于拖拽换位（不换节点时只调整 order） */
const ORDER_ROOT = '__root__'
const orderKeyOf = (nodeId) => nodeId || ORDER_ROOT
function dropFromOrder(s, key) {
  if (!s.order || typeof s.order !== 'object') s.order = {}
  for (const k of Object.keys(s.order)) {
    const i = s.order[k].indexOf(key)
    if (i >= 0) s.order[k].splice(i, 1)
  }
}
function insertToOrder(s, nodeId, key, index) {
  if (!s.order || typeof s.order !== 'object') s.order = {}
  const k = orderKeyOf(nodeId)
  const list = (s.order[k] = Array.isArray(s.order[k]) ? s.order[k] : [])
  if (index === null || index === undefined || index < 0 || index > list.length) list.push(key)
  else list.splice(index, 0, key)
}

/** 移动规则（唯一归属：写入 placements；nodeId=null → 未分类）；index 指定同节点内插入位置（拖拽换位/移到顶部） */
export function moveRule({ schemeId, key, nodeId = null, index = null } = {}) {
  if (!key) throw new Error('缺少规则 key')
  mutate((s) => {
    if (nodeId && !findNode(s.nodes, nodeId)) throw new Error('目标节点不存在：' + nodeId)
    dropFromOrder(s, key)
    if (nodeId) s.placements[key] = nodeId
    else s.placements[key] = null
    insertToOrder(s, nodeId, key, index)
  }, { schemeId })
  return { moved: key, nodeId, index }
}

/** 规则列表（某节点含子孙 / 未分类） */
export function rulesOfNode(scheme, rules, nodeId = null, { includeDescendants = true } = {}) {
  const assign = computeAssignments(scheme, rules)
  let ids = null
  if (nodeId && nodeId !== '__unassigned__') {
    const n = findNode(scheme.nodes, nodeId)
    if (!n) return []
    ids = new Set([nodeId])
    if (includeDescendants) walk(n.children ?? [], (c) => ids.add(c.id))
  }
  return rules.filter((r) => {
    const v = assign.get(r.key)
    if (!nodeId || nodeId === '__unassigned__') return v === null || v === undefined
    return ids.has(v)
  })
}

/** 恢复默认方案结构（保留用户方案） */
export function resetDefaultScheme() {
  const schemes = loadSchemes().map((s) => (s.id === DEFAULT_SCHEME.id ? clone(DEFAULT_SCHEME) : s))
  saveSchemes(schemes)
  return getScheme(DEFAULT_SCHEME.id)
}

export function assignableTags(rules = loadRules()) {
  const all = new Set()
  for (const r of rules) for (const t of tagsOfStrict(r)) all.add(t)
  return [...all].sort()
}
