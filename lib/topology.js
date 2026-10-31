/**
 * dsh-rules · 流程拓扑（一条准则属于哪个"完整项目/流水线"）
 *
 * 一条准则通常是从某个完整流程里抽出来的一条；单看会晕，所以这里把它放回所在流程：
 *   source（来源，如 harvest:xxx / skill:xxx / manual）→ 同一来源的准则构成一组；
 *   不足 2 条时退化为「同一任务域」或「同一类别」。
 * 组内按"阶段"排列（路径/安装 → 工具 → 流程 → 风格 → 安全 → 模型/成本 → 技能），
 * 阶段之间、阶段内的相邻项构成顺序边（seq），用于画拓扑。
 */

const STAGES = [
  { id: 'setup', label: '环境与路径', cats: ['paths', 'install'] },
  { id: 'tools', label: '工具与选型', cats: ['tools'] },
  { id: 'process', label: '流程与工作方式', cats: ['workflow'] },
  { id: 'output', label: '产出与风格', cats: ['style'] },
  { id: 'safety', label: '安全与底线', cats: ['safety'] },
  { id: 'model', label: '模型与成本', cats: ['model'] },
  { id: 'skill', label: '技能与插件', cats: ['skill'] },
  { id: 'other', label: '其他', cats: ['imported', 'notify'] },
]
const stageOf = (cat) => STAGES.find((s) => s.cats.includes(cat)) || STAGES[STAGES.length - 1]
const CAT_LABEL = { paths: '路径', install: '安装', tools: '工具', workflow: '流程', style: '风格', safety: '安全', model: '模型', skill: '技能', imported: '其他', notify: '通知' }
/** 整套流程的来源特征：技能文档、风格包、插件/项目包、配置文件等"整体获得"的来源 */
const PACKAGE_SOURCE = /(SKILL\.md|style-packs|\.config\.json|^skill:|^harvest:|^proj:|^plugin|^pkg:|^market)/i

export function buildTopology(rules, key) {
  const focus = rules.find((r) => r.key === key)
  if (!focus) return null
  let group = rules.filter((r) => r.source && r.source === focus.source)
  let basis = 'source'
  let basisLabel = focus.source
  if (group.length < 2) {
    const domain = (focus.appliesTo || [])[0] || null
    if (domain) {
      group = rules.filter((r) => (r.appliesTo || []).includes(domain))
      basis = 'domain'; basisLabel = domain
    }
  }
  if (group.length < 2) {
    group = rules.filter((r) => r.category === focus.category)
    basis = 'category'; basisLabel = CAT_LABEL[focus.category] || focus.category
  }
  if (!group.some((r) => r.key === focus.key)) group = [...group, focus]

  // 按阶段分组
  const byStage = new Map()
  for (const r of group) {
    const st = stageOf(r.category)
    if (!byStage.has(st.id)) byStage.set(st.id, { id: st.id, label: st.label, items: [] })
    byStage.get(st.id).items.push(r)
  }
  const stages = [...byStage.values()]
  for (const st of stages) st.items.sort((a, b) => String(a.key).localeCompare(String(b.key)))

  // 顺序边：阶段内 prev→next；阶段之间 last→first
  const edges = []
  let prevLast = null
  for (const st of stages) {
    let prev = null
    for (const r of st.items) {
      if (prev) edges.push({ from: prev.key, to: r.key, kind: 'seq' })
      prev = r.key
    }
    if (prevLast && st.items.length) edges.push({ from: prevLast, to: st.items[0].key, kind: 'stage' })
    if (st.items.length) prevLast = st.items[st.items.length - 1].key
  }

  // 规则形态：整套流程（插件/技能包/项目整体提取） vs 零散学习（手动/对话/起草）
  const isPackageSource = PACKAGE_SOURCE.test(String(focus.source || ''))
  const kind = basis === 'source' && isPackageSource ? 'package' : 'scattered'
  const ordered = stages.flatMap((st) => st.items)
  const entry = ordered[0] || null
  const exit = ordered[ordered.length - 1] || null

  return {
    basis,
    kind,
    kindLabel: kind === 'package' ? '整套流程' : '零散学习',
    note: kind === 'package'
      ? '从同一来源整体提取：从入口到结果是一条完整流程'
      : '零散学到的准则，没有固定流程；按类别/任务域放在一起看',
    entry: entry ? { key: entry.key, title: entry.title || entry.key } : null,
    exit: exit ? { key: exit.key, title: exit.title || exit.key } : null,
    basisLabel,
    source: focus.source || null,
    total: group.length,
    focus: { key: focus.key, title: focus.title || focus.key, value: String(focus.value || '').slice(0, 200) },
    domains: [...new Set(group.flatMap((r) => r.appliesTo || []))],
    stages: stages.map((st) => ({
      id: st.id,
      label: st.label,
      items: st.items.map((r) => ({
        key: r.key,
        title: r.title || r.key,
        category: r.category,
        categoryLabel: CAT_LABEL[r.category] || r.category,
        current: r.key === focus.key,
        entry: entry ? r.key === entry.key : false,
        exit: exit ? r.key === exit.key : false,
      })),
    })),
    edges,
  }
}
