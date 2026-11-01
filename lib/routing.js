/**
 * dsh-rules · 语义路由（v0.3）
 *
 * A 档（默认，零依赖）：标签 + 同义词扩展 + 字符二元组相似度 + 关键词命中加权。
 * B 档（可选）：若安装并缓存了本地 embedding（lib/embedding.js），用向量余弦精排；
 *              不可用时自动回退 A，不阻塞。
 *
 * 只读建议：路由结果只影响「推荐哪些规则/风格包」，绝不自动改 active 或改规则。
 */
import { loadRules, labelOf } from './store.js'
import { tagsOf, tagsOfStrict } from './tags.js'
import { decisionsOf } from './decisions.js'
import { loadSchemes } from './tree.js'

function defaultScheme() {
  try {
    const schemes = loadSchemes()
    return schemes.find((s) => s.id === 'default') || schemes[0] || null
  } catch { return null }
}

/** 领域同义词：用于把口语化任务扩展到领域/标签 */
const SYNONYMS = {
  ppt: ['ppt', '幻灯片', '演示', 'slides', 'slide', 'deck', '汇报材料', '路演', '宣讲', '做一份汇报', '给领导看'],
  paper: ['论文', 'paper', '期刊', '投稿', '学位论文', '毕业论文', 'gb7714', '参考文献', '引用', '学术'],
  report: ['报告', '周报', '月报', '总结', '汇报', '复盘', 'report'],
  diagram: ['图表', '图', '架构图', '流程图', '示意图', 'diagram', '可视化', '画个图'],
  office: ['office', 'word', 'excel', 'ppt文件', 'pptx', 'docx', 'xlsx', '表格', '工作簿', '文档', '幻灯片文件', '可编辑'],
  blender: ['blender', '3d', '建模', '模型', '渲染', '材质', '灯光', '相机', 'glb', 'gltf', '场景', '角色'],
  animation: ['动画', '动效', '视频', '短片', '逐帧', '转场', 'motion'],
  coding: ['代码', '编程', '写代码', '重构', '测试', 'tdd', '评审', 'code review', '调试', 'bug', '架构', '模块', '接口', 'spec', 'tickets', '合并', '冲突', 'git'],
  safety: ['安全', '危险', '删除', '覆盖', '不可逆', '脱敏', '密钥', '凭据', '隐私', '红线', '确认'],
  memory: ['记忆', '经验', 'ag ments', 'agents.md', '经验库', '维护', '过期', '校准'],
  skill: ['技能', '插件', 'skill', 'plugin', 'mcp', '安装技能', '体检'],
  install: ['安装', '下载', '装', '镜像', '代理', '路径', '目录', '校验'],
  model: ['余额', '预算', '价格', '成本', 'token', '峰谷', '低谷', '省钱'],
  communication: ['回答', '回复', '汇报', '沟通', '风格', '精简', '中文'],
}

const domainTags = (text) => Object.entries(SYNONYMS).filter(([, words]) => words.some((w) => text.includes(w))).map(([d]) => d)

const bigrams = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
const jac = (A, B) => { if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i) }

/** 对单条规则打分（0–1）：key/title 标签强命中 + 分类/key 前缀 + key/title 字面相似；value 只弱加权 */
export function scoreRule(rule, task, { taskTags } = {}) {
  const q = String(task ?? '').toLowerCase()
  const tags = taskTags ?? domainTags(q)
  const strict = tagsOfStrict(rule)
  const loose = tagsOf(rule)
  const keyTitle = [rule.key, rule.title].filter(Boolean).join(' ').toLowerCase()
  let score = 0
  // 1) 强标签命中（key/title 推断/显式）
  const hitStrict = tags.filter((t) => strict.includes(t))
  score += Math.min(0.7, hitStrict.length * 0.35)
  // 2) 弱标签（value 里出现的）只给很小权重
  const hitLoose = tags.filter((t) => !strict.includes(t) && loose.includes(t))
  score += Math.min(0.2, hitLoose.length * 0.1)
  // 3) 分类命中 + key 前缀与领域一致
  if (tags.includes(rule.category)) score += 0.15
  for (const t of tags) if (rule.key.startsWith(t + '.')) { score += 0.12; break }
  // 4) 字面相似：key/title 权重高，value 低
  score += jac(bigrams(q), bigrams(keyTitle)) * 0.8
  score += jac(bigrams(q), bigrams(rule.value)) * 0.2
  // 5) 同义词词条直命中 key/title（+0.06/条，最多 3 条）
  let direct = 0
  for (const t of tags) for (const w of SYNONYMS[t] ?? []) {
    if (keyTitle.includes(w.toLowerCase())) { direct++; break }
  }
  score += Math.min(0.18, direct * 0.06)
  return Math.min(1, score)
}

/** 任务 → 推荐规则（topK）；可选只取某个适用面 */
export function rulesForTask(task, { topK = 12, rules = loadRules(), threshold = 0.18, coverage = null, domains = null } = {}) {
  const taskTags = domainTags(String(task ?? '').toLowerCase())
  const domSet = Array.isArray(domains) && domains.length ? new Set(domains) : null
  const scored = rules
    .filter((r) => (coverage ? (r.coverage || 'default') === coverage : true))
    .filter((r) => (domSet ? (r.coverage !== 'local' || (r.appliesTo || []).some((d) => domSet.has(d))) : true))
    .map((r) => ({ rule: r, tags: tagsOf(r), score: Number(scoreRule(r, task, { taskTags }).toFixed(3)) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((x) => ({
    key: x.rule.key,
    title: x.rule.title || labelOf(x.rule.key),
    category: x.rule.category,
    coverage: x.rule.coverage || 'default',
    appliesTo: x.rule.appliesTo || [],
    tags: x.tags,
    score: x.score,
    value: x.rule.value,
  }))
}

/** 任务 → 领域建议（把命中的标签当作候选领域，排除纯沟通标签） */
export function suggestDomains(task) {
  const tags = domainTags(String(task ?? '').toLowerCase())
  return tags.filter((t) => !['communication', 'safety', 'memory'].includes(t))
}

/** 组合路由结果：默认规则（常驻，挑相关的）+ 局部规则（只取与本任务域相交的）+ 使用的标签 */
export function routeTask(task, opts = {}) {
  const q = String(task ?? '').trim()
  const tags = domainTags(q.toLowerCase())
  const domains = suggestDomains(q)
  const localRules = rulesForTask(q, { ...opts, coverage: 'local', domains })
  const defaultRules = rulesForTask(q, { ...opts, coverage: 'default' })
  // 未命中任务域时，局部规则不会被自动带上；但"任务描述里没提到域"≠"不需要"，
  // 所以额外给一批低置信候选（带分数），由调用方/agent 判断是否采纳
  const allLocal = rulesForTask(q, { ...opts, coverage: 'local' })
  const activeKeys = new Set(localRules.map((x) => x.key))
  const localCandidates = allLocal.filter((x) => !activeKeys.has(x.key)).slice(0, 5).map((x) => ({ ...x, lowConfidence: true }))
  // 决策点冲突：同一决策点有多个生效分支时，agent 必须停下来让用户选
  const decisions = decisionsOf(loadRules(), { domains, scheme: defaultScheme(), session: String(opts.session || '') })
  return {
    task: q,
    tags,
    domains,
    decisions: decisions.map((d) => ({
      ...d,
      options: d.options.map((o) => ({ ...o, value: Array.isArray(o.rules) ? o.rules.slice(0, 20) : o.rules })),
    })),
    hasBranchConflict: decisions.some((d) => d.conflict),
    // 兼容旧字段：全量混合推荐（默认+局部一起打分，取 topK）
    rules: rulesForTask(q, opts),
    defaultRules,
    localRules,
    localCandidates,
    counts: { default: defaultRules.length, local: localRules.length, localCandidates: localCandidates.length },
    // 本次任务里"算全局"的规则集合（默认规则恒在；局部规则只算命中的）
    contextKeys: [...defaultRules.map((x) => x.key), ...localRules.map((x) => x.key)],
  }
}

/** B 档：本地 embedding 精排；不可用/未构建时回退 A 档（返回 mode 说明） */
export async function routeTaskSemantic(task, { topK = 12, session = '' } = {}) {
  const lexical = routeTask(task, { topK, session })
  try {
    const { semanticSearch, semanticDomainsByAnchors, embeddingsBuilt } = await import('./embedding.js')
    if (!embeddingsBuilt()) return { ...lexical, mode: 'lexical', reason: 'embedding 缓存未构建（node scripts/build-embeddings.mjs）' }
    const rules = loadRules()
    const rows = await semanticSearch(task, rules, { topK: Math.max(topK, 40), scoreRule })
    if (!rows.length) return { ...lexical, mode: 'lexical', reason: 'embedding 无结果' }
    const anchorHits = await semanticDomainsByAnchors(task)
    const domains = anchorHits.map((d) => d.tag)
    const tags = [...new Set([...domains, ...domainTags(String(task).toLowerCase())])]
    const mapped = rows.slice(0, topK).map((x) => ({
      key: x.rule.key, title: x.rule.title || labelOf(x.rule.key), category: x.rule.category,
      coverage: x.rule.coverage || 'default', appliesTo: x.rule.appliesTo || [],
      tags: tagsOf(x.rule), score: Number(x.score.toFixed(3)), sim: Number(x.sim.toFixed(3)), value: x.rule.value,
    }))
    const domSet = new Set(suggestDomains(String(task)))
    const localRules = mapped.filter((r) => r.coverage === 'local' && (!domSet.size || (r.appliesTo || []).some((d) => domSet.has(d))))
    const defaultRules = mapped.filter((r) => r.coverage === 'default')
    const activeKeys = new Set(localRules.map((x) => x.key))
    const localCandidates = mapped.filter((r) => r.coverage === 'local' && !activeKeys.has(r.key))
      .slice(0, 5).map((x) => ({ ...x, lowConfidence: true }))
    return {
      task: String(task ?? '').trim(),
      mode: 'embedding',
      tags,
      domains: domains.length ? domains : lexical.domains,
      decisions: lexical.decisions,
      hasBranchConflict: lexical.hasBranchConflict,
      rules: mapped,
      defaultRules,
      localRules,
      localCandidates,
      counts: { default: defaultRules.length, local: localRules.length, localCandidates: localCandidates.length },
      contextKeys: [...defaultRules.map((x) => x.key), ...localRules.map((x) => x.key)],
      lexicalCount: lexical.rules.length,
    }
  } catch (e) {
    return { ...lexical, mode: 'lexical', reason: 'embedding 不可用：' + String(e?.message ?? e) }
  }
}
