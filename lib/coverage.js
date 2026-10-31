/**
 * dsh-rules · 适用面推断（coverage inference）
 *
 * 优先级：规则上显式写的 coverage（explicit，置信 1.0）
 *   → 分类表 coverage-map.json 的按键记录（map，0.9）
 *   → 任务域关键词命中（keyword，0.6~0.75；命中即 local + appliesTo）
 *   → 类别兜底（category，0.5；仅对"几乎总是通用/几乎总是局部"的类别）
 *   → 兜底 local + 空任务域 + needsReview（0.2，进待复核队列；保守：不默认可用了）
 *
 * 设计原则：宁可把不确定的放进待复核，也不要静默地把它当常驻/局部。
 */
export const CATEGORY_DEFAULT = {
  // 几乎总是通用（任何任务都可能用）
  paths: 'default',
  install: 'default',
  safety: 'default',
  // 几乎总是任务特定（需要关键词/前缀进一步定位域）
  style: 'local-review',
  tools: 'local-review',
  skill: 'local-review',
  workflow: 'local-review',
  model: 'local-review',
  imported: 'review',
  notify: 'review',
}

/** 域关键词：用于给没有显式/前缀记录的规则推断它属于哪个任务域 */
export const DOMAIN_HINTS = {
  ppt: ['ppt', '幻灯片', '演示', 'slides', 'deck', '路演', '宣讲'],
  paper: ['论文', '参考文献', 'gb7714', '期刊', '投稿', '摘要', '引用'],
  report: ['汇报', '周报', '月报', '复盘', '报告'],
  diagram: ['图表', '流程图', '架构图', '示意图', 'diagram', '可视化'],
  office: ['docx', 'pptx', 'xlsx', 'word', 'excel', 'powepoint', 'powerpoint', 'office', '单元格', '工作簿'],
  blender: ['blender', 'glb', 'gltf', '建模', '材质', 'roughness', 'metallic', '渲染', '灯光', '相机'],
  animation: ['动画', '动效', '逐帧', '转场', 'motion', '视频'],
  audio: ['配音', '音色', 'tts', '语音', '音频'],
  coding: ['代码', '测试', 'tdd', '评审', '调试', '重构', 'git', 'merge', 'spec', 'ticket', 'seam', 'adr', '模块'],
  research: ['调研', '文献', '问卷', '一手来源'],
  teaching: ['教学', '课程', '学习', '上课', '讲课'],
  harness: ['harness', '评测', 'probe', '盲评'],
  'agent-docs': ['skill.md', '技能正文', '提示词', '指针', 'agent 文档', '工具定义', 'leader word', 'leading word'],
  skill: ['技能', '插件', 'skill', 'plugin', '安装技能', '体检', '安装包'],
  'style-packs': ['风格包', 'style-pack', '风格', '准则校准', 'pack'],
  'dsh-plugin': ['cordis', 'preset', '插件安装', 'bundle', 'profile'],
  scheduling: ['排期', '峰谷', '低谷', '定时', '夜间任务', '成本时段'],
  bili: ['b站', 'bilibili', '养鱼', '评论', '私信', '弹幕'],
}

const norm = (s) => String(s ?? '').toLowerCase()
const domainByKeyword = (rule) => {
  const text = norm(rule.key + ' ' + (rule.title || '') + ' ' + (rule.value || '') + ' ' + (rule.tags || []).join(' '))
  const hits = []
  for (const [id, words] of Object.entries(DOMAIN_HINTS)) {
    if (words.some((w) => text.includes(w))) hits.push(id)
  }
  return hits
}

/**
 * @param {object} rule 规则（可含显式 coverage / appliesTo / coverageSource）
 * @param {object} map  coverage-map.json 的内容 { map: {key:{coverage,appliesTo}} }
 * @returns {{coverage:'default'|'local', appliesTo:string[], coverageSource:string, confidence:number, needsReview:boolean, suggestion?:object}}
 */
export function inferCoverage(rule, map = {}) {
  // 1) 显式（人工或复核后写入）
  if (rule.coverage === 'default' || rule.coverage === 'local') {
    return {
      coverage: rule.coverage,
      appliesTo: Array.isArray(rule.appliesTo) ? rule.appliesTo : [],
      coverageSource: rule.coverageSource || 'explicit',
      confidence: rule.coverageSource === 'review' ? 1 : 1,
      needsReview: false,
    }
  }
  // 2) 分类表（按键生成，全量列表时由 coverage-map.mjs 产出）
  const hit = map?.map?.[rule.key]
  if (hit) return { coverage: hit.coverage, appliesTo: hit.appliesTo || [], coverageSource: hit.source || 'map', confidence: 0.9, needsReview: false }
  // 3) 关键词推断域
  const domains = domainByKeyword(rule)
  if (domains.length) {
    return { coverage: 'local', appliesTo: domains, coverageSource: 'keyword', confidence: 0.6, needsReview: domains.length > 2 }
  }
  // 4) 类别兜底
  const cat = CATEGORY_DEFAULT[rule.category]
  if (cat === 'default') return { coverage: 'default', appliesTo: [], coverageSource: 'category', confidence: 0.5, needsReview: false }
  if (cat === 'local-review') {
    return { coverage: 'local', appliesTo: [], coverageSource: 'category', confidence: 0.3, needsReview: true, suggestion: { coverage: 'local', appliesTo: [] } }
  }
  // 5) 兜底（保守）：判为局部、不进入任何任务域、默认不生效，并进待复核队列
  return { coverage: 'local', appliesTo: [], coverageSource: 'fallback', confidence: 0.2, needsReview: true, suggestion: { coverage: 'local', appliesTo: [] } }
}

/** 批量推断；返回带推断字段的规则 + 待复核列表 */
export function classifyAll(rules, map = {}) {
  const out = []
  const review = []
  for (const r of rules) {
    const inf = inferCoverage(r, map)
    const next = {
      ...r,
      coverage: inf.coverage,
      appliesTo: inf.appliesTo,
      coverageSource: inf.coverageSource,
      coverageConfidence: inf.confidence,
      needsReview: inf.needsReview,
    }
    out.push(next)
    if (inf.needsReview) review.push({ key: r.key, title: r.title || r.key, category: r.category, coverage: inf.coverage, confidence: inf.confidence, reason: inf.coverageSource, suggestion: inf.suggestion || { coverage: inf.coverage, appliesTo: inf.appliesTo } })
  }
  return { rules: out, review }
}
