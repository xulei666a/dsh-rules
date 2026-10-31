/**
 * dsh-rules · 适用面（coverage）分类表
 *
 * coverage = default｜local
 *   default：不绑定具体任务，任何会话都该生效（回答方式、路径、安装、安全、交付纪律…）
 *   local  ：只在特定任务域/流程里才该出现（做 PPT / 写论文 / 建模 / 改插件…）
 * local 规则用 appliesTo 标任务域；运行时按任务路由命中后，它在这次任务里就成了"全局约束"。
 *
 * 用法：node scripts/coverage-map.mjs [--check]
 *   生成 ~/.dsh/rules/coverage-map.json（键 → coverage/appliesTo）
 *   --check 只校验不写盘（校验 207 条全部有分类、无未知 key）
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULES_DIR, STORE_FILE } from '../lib/store.js'

export const DOMAINS = {
  ppt: '演示文稿（PPT/幻灯片）',
  paper: '论文与学术写作',
  report: '报告与汇报',
  diagram: '图表与可视化',
  office: 'Office 文件（Word/Excel/PPT 文件）',
  blender: '3D 与 Blender',
  animation: '动画与视频',
  audio: '配音与音频',
  coding: '代码工程（TDD/评审/调试/架构）',
  research: '调研与问卷',
  teaching: '教学与学习设计',
  harness: 'Harness 改进与评测',
  'agent-docs': 'Agent 文档/技能/工具定义写作',
  skill: '技能与插件的发现、体检、安装',
  'style-packs': '风格包与准则校准',
  'dsh-plugin': 'DSH 插件与 preset 安装配置',
  scheduling: '任务排期与成本时段',
  bili: '个人领域（B站养鱼）',
}

/** default：不绑定任务域，常驻注入 */
export const DEFAULT_KEYS = [
  // 路径与安装
  'paths.downloads', 'paths.install', 'paths.deliverables', 'paths.scratch', 'paths.models',
  'install.prefer_portable', 'install.user_scope', 'install.github_proxy', 'install.verify_checksum',
  // 通用工具
  'tools.search', 'tools.github_api_limit', 'tools.python_windows', 'tools.script_content_file', 'tools.json_bom',
  'tools.modlens.vision_bridge',
  // 安全红线
  'safety.delete_confirm', 'safety.no_global_npm', 'safety.approval_first', 'safety.redact_secrets', 'safety.identity_honesty',
  // 工作方式
  'workflow.report_style', 'workflow.verify_before_claim', 'workflow.evidence_level',
  'workflow.agent_experience_bounded_output', 'workflow.self_review_gate', 'workflow.memory_recalibration',
  'workflow.language_zh', 'workflow.simple_answer_direct', 'workflow.butler_mode', 'workflow.cost_gate',
  'workflow.prose_clarify', 'workflow.change_log', 'workflow.batch_audit', 'workflow.background_job',
  'install.cn_mirror',
]

/** local：按键前缀/明确列表挂到任务域（同一 key 可挂多域） */
const LOCAL_PREFIXES = [
  ['style.ppt', ['ppt']],
  ['style.paper', ['paper']],
  ['style.report', ['report']],
  ['style.diagram', ['diagram']],
  ['style.blender', ['blender']],
  ['style.voice', ['audio']],
  ['style.reply', ['bili']],
  ['style.routing', ['style-packs']],
  ['tools.ppt', ['ppt']],
  ['tools.paper', ['paper']],
  ['tools.diagram', ['diagram']],
  ['tools.xlsx', ['office']],
  ['tools.docx', ['office']],
  ['tools.pptx', ['office']],
  ['tools.office', ['office']],
  ['tools.blender', ['blender']],
  ['tools.animation', ['animation']],
  ['workflow.office', ['office']],
  ['workflow.blender', ['blender']],
  ['workflow.ppt', ['ppt']],
  ['workflow.diagram', ['diagram']],
  ['workflow.animation', ['animation']],
  ['workflow.teach', ['teaching']],
  ['workflow.triage', ['coding']],
  ['workflow.cordis', ['dsh-plugin']],
  ['workflow.style_pack', ['style-packs']],
  ['workflow.rule_calibration', ['style-packs']],
  ['workflow.research', ['research']],
  ['workflow.questionnaire', ['research']],
  ['workflow.harness', ['harness']],
  ['workflow.bug_loop', ['coding']],
  ['workflow.debug_instrumentation', ['coding']],
  ['workflow.review', ['coding']],
  ['workflow.deep', ['coding']],
  ['workflow.deletion_test', ['coding']],
  ['workflow.merge', ['coding']],
  ['workflow.prototype', ['coding']],
  ['workflow.wizard', ['coding']],
  ['workflow.grilling', ['coding']],
  ['workflow.domain_model', ['coding']],
  ['workflow.adr', ['coding']],
  ['workflow.main_flow', ['coding']],
  ['workflow.context_handoff', ['coding']],
  ['workflow.wayfinder', ['coding']],
  ['workflow.claim_before_work', ['coding']],
  ['workflow.tdd', ['coding']],
  ['workflow.test_', ['coding']],
  ['workflow.vertical_slice', ['coding']],
  ['workflow.seam', ['coding']],
  ['workflow.spec_contract', ['coding']],
  ['workflow.no_invented', ['coding']],
  ['workflow.repo_setup', ['coding']],
  ['skill.cordis', ['dsh-plugin']],
  ['install.dsh_desktop_plugin', ['dsh-plugin']],
  ['skill.hard_risk_gate', ['skill']],
  ['skill.install_procedure', ['skill']],
  ['skill.rank_shadowing', ['skill']],
  ['skill.lifecycle', ['skill']],
  ['skill.auto_install_min_score', ['skill']],
  ['skill.daily_budget', ['skill']],
  ['style.repitch', ['teaching']],
  ['workflow.no_over_investigation', ['bili']],
  ['skill.blender', ['blender']],
  ['skill.pointer_wording', ['agent-docs']],
  ['skill.tool_definition_rules', ['agent-docs']],
  ['skill.single_source', ['agent-docs']],
  ['skill.harness_edit_cost', ['harness']],
  ['skill.experience_library', ['agent-docs']],
  ['skill.positive_prompting', ['agent-docs']],
  ['skill.doc_pruning', ['agent-docs']],
  ['skill.leading_words', ['agent-docs']],
  ['workflow.agent_experience_min_context', ['agent-docs']],
  ['workflow.agent_preset_edit', ['dsh-plugin']],
  ['workflow.component_reuse', ['teaching']],
  ['safety.office', ['office']],
  ['safety.blender', ['blender']],
  ['paths.blender', ['blender']],
  ['model.offpeak', ['scheduling']],
  ['model.schedule_window', ['scheduling']],
  ['agent.reply_max_chars', ['bili']],
  ['agent.ack_before_work', ['bili']],
  ['bili_whale', ['bili']],
  ['imported.bili_whale', ['bili']],
]

const trimPrefix = (k) => k.split('.').slice(-1)[0]

export function buildCoverage(keys) {
  const defaults = new Set(DEFAULT_KEYS)
  const map = {}
  const missing = []
  for (const key of keys) {
    if (defaults.has(key)) { map[key] = { coverage: 'default' }; continue }
    let hit = null
    for (const [prefix, domains] of LOCAL_PREFIXES) {
      // 前缀按原始字符串匹配：'workflow.office' 命中 workflow.office_verify / workflow.office_routing
      if (key === prefix || key.startsWith(prefix)) { hit = domains; break }
    }
    if (!hit) { missing.push(key); continue }
    map[key] = { coverage: 'local', appliesTo: hit }
  }
  return { map, missing }
}

export function coverageFilePath() { return path.join(RULES_DIR, 'coverage-map.json') }

function main() {
  const check = process.argv.includes('--check')
  const raw = fs.readFileSync(STORE_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const keys = raw.map((r) => r.key)
  const { map, missing } = buildCoverage(keys)
  const local = Object.values(map).filter((x) => x.coverage === 'local')
  console.log(`规则 ${keys.length} 条：default ${keys.length - local.length}，local ${local.length}`)
  if (missing.length) {
    console.error('未分类（必须补进 DEFAULT_KEYS 或 LOCAL_PREFIXES）：\n' + missing.map((k) => ' - ' + k).join('\n'))
    process.exit(1)
  }
  const byDomain = {}
  for (const v of local) for (const d of v.appliesTo) byDomain[d] = (byDomain[d] || 0) + 1
  console.log('局部域分布：' + JSON.stringify(Object.fromEntries(Object.entries(byDomain).sort((a, b) => b[1] - a[1]))))
  if (check) return
  const out = { version: 1, updatedAt: new Date().toISOString(), domains: DOMAINS, map }
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(coverageFilePath(), JSON.stringify(out, null, 2), 'utf8')
  console.log('已写入 ' + coverageFilePath())
}

if (process.argv[1] && process.argv[1].endsWith('coverage-map.mjs')) main()
