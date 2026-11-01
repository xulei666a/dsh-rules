/**
 * 决策点 / 分支冲突
 *
 * 两种声明方式：
 * 1. 规则级：rules.jsonl 里给规则加 `decision`（点分 id）+ `option`（人类可读名）。
 * 2. 文件夹级（更适合「两套方案」）：给分类节点加 `decision` + `option`，
 *    该节点下所有规则都算这个选项下的实现细节。
 *
 * 语义：
 * - 同一 decision 上有 ≥2 个生效选项 → 分支冲突：运行时必须让用户选，agent 不能自己拍板。
 * - decision 前缀关系（video.pipeline vs video.pipeline.v3）视为上下位，不算冲突。
 */
import { resolveEffective, loadRules } from './store.js'
import { computeAssignments } from './tree.js'

const norm = (v) => String(v ?? '').trim()

function nodeChain(nodeById, nodeId) {
  const chain = []
  let cur = nodeId
  let guard = 0
  while (cur && guard++ < 64) {
    const n = nodeById.get(cur)
    if (!n) break
    chain.push(n)
    cur = n.parentId
  }
  return chain
}

function indexNodes(scheme) {
  const by = new Map()
  const walk = (nodes, parentId) => {
    for (const n of nodes || []) {
      by.set(n.id, { ...n, parentId })
      if (n.children) walk(n.children, n.id)
    }
  }
  walk(scheme?.nodes, null)
  return by
}

/**
 * @param {object} rules 全量规则
 * @param {object} opts { session, domains, scheme }
 * @returns {Array<{decision:string, conflict:boolean, options:Array}>}
 */
export function decisionsOf(rules = loadRules(), { session = '', domains = null, scheme = null } = {}) {
  const eff = resolveEffective(rules, session ? { session } : {})
  const domainSet = Array.isArray(domains) && domains.length ? new Set(domains) : null
  const nodeById = scheme ? indexNodes(scheme) : new Map()
  const assign = scheme ? computeAssignments(scheme, rules) : null
  const by = new Map() // decision -> Map(optionId -> option)

  const addOption = (decision, optionId, option, rule) => {
    if (!by.has(decision)) by.set(decision, new Map())
    const opts = by.get(decision)
    if (!opts.has(optionId)) opts.set(optionId, { id: optionId, option, rules: [] })
    opts.get(optionId).rules.push(rule.key)
  }

  for (const r of eff) {
    if (r.status !== 'active') continue
    if (domainSet && r.coverage === 'local') {
      if (!(r.appliesTo || []).some((d) => domainSet.has(d))) continue
    }
    // 1) 规则自身声明优先
    const ownDecision = norm(r.decision)
    if (ownDecision) {
      addOption(ownDecision, 'rule:' + r.key, norm(r.option) || r.title || r.key, r)
      continue
    }
    // 2) 否则继承所属文件夹（最近一个带 decision 的祖先）
    if (!scheme) continue
    const nodeId = assign.get(r.key) ?? null
    if (!nodeId) continue
    for (const n of nodeChain(nodeById, nodeId)) {
      const d = norm(n.decision)
      if (!d) continue
      addOption(d, 'node:' + n.id, norm(n.option) || n.title || n.id, r)
      break
    }
  }

  return [...by.entries()].map(([decision, optsMap]) => {
    const options = [...optsMap.values()].map((o) => ({
      ...o,
      kind: o.id.startsWith('node:') ? 'node' : 'rule',
      nodeId: o.id.startsWith('node:') ? o.id.slice(5) : null,
      count: o.rules.length,
    }))
    return {
      decision,
      conflict: options.length > 1,
      options: options.sort((a, b) => a.option.localeCompare(b.option)),
    }
  }).sort((a, b) => (b.conflict ? 1 : 0) - (a.conflict ? 1 : 0) || a.decision.localeCompare(b.decision))
}

export function conflictsOf(rules = loadRules(), opts = {}) {
  return decisionsOf(rules, opts).filter((d) => d.conflict)
}

/** 某条规则参与的所有决策点（用于卡片标橙；含从文件夹继承的） */
export function decisionsForRule(rules, key, opts = {}) {
  return decisionsOf(rules, opts).filter((d) => d.options.some((o) => o.kind === 'rule' ? o.id === 'rule:' + key : opHasRule(o, key)))
}

function opHasRule(option, key) {
  return Array.isArray(option.rules) && option.rules.includes(key)
}
