#!/usr/bin/env node
/**
 * 离线自检：在临时 HOME 里跑「规则 CRUD → 分类树（方案/节点/移动/不复制）→ 语义路由 → 默认值」。
 * 不碰真实 ~/.dsh/rules。用法: node scripts/selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rules-selftest-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')          // 避免沿用真实 ~/.dsh（来源台账等）
process.env.DSH_RULES_DIR = path.join(tmp, '.dsh', 'rules')
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const lib = (f) => pathToFileURL(path.join(here, '..', 'lib', f)).href

let passed = 0
const fails = []
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { fails.push(name + (detail ? '：' + detail : '')); console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

try {
  const store = await import(lib('store.js'))
  const tags = await import(lib('tags.js'))
  const tree = await import(lib('tree.js'))
  const routing = await import(lib('routing.js'))

  // 1) 随包默认值
  const defaults = JSON.parse(fs.readFileSync(path.join(here, '..', 'rules', 'defaults.json'), 'utf8').replace(/^\uFEFF/, ''))
  check('defaults.json 可解析且非空', Array.isArray(defaults) && defaults.length > 0, `条数 ${defaults.length}`)
  const badDefaults = defaults.filter((r) => { try { const n = store.normalizeRule(r); return !n.key || !n.value || !n.category } catch { return true } })
  check('defaults 每条都通过 normalizeRule', badDefaults.length === 0, badDefaults.map((r) => r.key).join(','))
  check('defaults 无个人私有内容', defaults.filter((r) => /[A-Za-z]:\\Users\\|\/home\/|\/Users\//.test(JSON.stringify(r))).length === 0)

  // 2) 规则 CRUD
  store.upsertRule({ key: 'selftest.paths', value: 'D:/work', category: 'paths', status: 'active', tags: ['install'] }, { sync: false })
  check('upsert 后可读到', store.loadRules().some((r) => r.key === 'selftest.paths'))
  check('解析生效', store.resolveEffective(store.loadRules(), { keys: ['selftest.paths'] }).length === 1)
  store.removeRule('selftest.paths')
  check('remove 后消失', !store.loadRules().some((r) => r.key === 'selftest.paths'))

  // 3) 内置方案（默认分类树）
  const d = tree.getScheme('default')
  check('内置方案存在且是内置', Boolean(d && d.builtin))
  const dv = tree.schemeView(d, store.loadRules())
  check('内置方案有 5 个大类（含待复核）', dv.roots.length === 5, `实际 ${dv.roots.length}`)
  check('内置方案大类有子类', dv.roots.every((n) => n.children.length > 0))
  check('内置方案自动归类（已归类 > 0）', dv.assigned > 0, `assigned ${dv.assigned}`)
  let builtinDeleteErr = ''
  try { tree.deleteScheme('default') } catch (e) { builtinDeleteErr = String(e.message) }
  check('内置方案不可删除', /内置/.test(builtinDeleteErr), builtinDeleteErr)

  // 4) 自建方案 + 节点增删改移
  store.upsertRule({ key: 'myproj.deliver', value: '交付到 D:/proj/out', category: 'paths', status: 'active' }, { sync: false })
  store.upsertRule({ key: 'myproj.note', value: '项目备注规则', category: 'workflow', status: 'active' }, { sync: false })
  const s = tree.createScheme({ title: '自检方案' })
  check('createScheme 生成 id/title', Boolean(s.id && s.title === '自检方案'))
  const root = tree.addNode({ schemeId: s.id, title: '一级' })
  const child = tree.addNode({ schemeId: s.id, parentId: root.id, title: '二级' })
  const grand = tree.addNode({ schemeId: s.id, parentId: child.id, title: '三级' })
  check('可建任意层级（3 层）', Boolean(grand.id))
  tree.renameNode({ schemeId: s.id, nodeId: child.id, title: '二级改' })
  check('renameNode 生效', tree.findNode(tree.getScheme(s.id).nodes, child.id).title === '二级改')
  let cycleErr = ''
  try { tree.moveNode({ schemeId: s.id, nodeId: root.id, parentId: grand.id }) } catch (e) { cycleErr = String(e.message) }
  check('不能把节点移进自己的子级', /子级/.test(cycleErr), cycleErr)

  // 5) 移动规则（唯一归属、不能复制）
  tree.moveRule({ schemeId: s.id, key: 'myproj.note', nodeId: child.id })
  const moved = tree.rulesOfNode(tree.getScheme(s.id), store.loadRules(), child.id)
  check('规则移到目标节点', moved.some((r) => r.key === 'myproj.note'))
  const assign = tree.computeAssignments(tree.getScheme(s.id), store.loadRules())
  check('规则归属是单值 map（不能复制）', assign instanceof Map && [...assign.values()].filter((v) => v === child.id).length >= 1)
  tree.moveRule({ schemeId: s.id, key: 'myproj.note', nodeId: null })
  const unassigned = tree.rulesOfNode(tree.getScheme(s.id), store.loadRules(), '__unassigned__')
  check('可移到未分类', unassigned.some((r) => r.key === 'myproj.note'))
  tree.moveRule({ schemeId: s.id, key: 'myproj.note', nodeId: grand.id })
  check('复移后旧节点不再直接保留', !tree.rulesOfNode(tree.getScheme(s.id), store.loadRules(), child.id, { includeDescendants: false }).some((r) => r.key === 'myproj.note'))

  // 6) 删除节点 / 删除方案
  tree.deleteNode({ schemeId: s.id, nodeId: child.id })
  check('删除节点连同子类', !tree.findNode(tree.getScheme(s.id).nodes, grand.id))
  tree.deleteScheme(s.id)
  check('删除自建方案', !tree.listSchemes(store.loadRules()).some((x) => x.id === s.id))

  // 7) 语义路由（A 档零依赖）
  const r1 = routing.routeTask('给领导做一份季度汇报')
  check('路由命中 report 领域', r1.domains.includes('report'), r1.domains.join(','))
  const r2 = routing.routeTask('写代码修 bug 并补测试')
  check('路由命中 coding 领域', r2.domains.includes('coding'), r2.domains.join(','))
  check('路由返回规则带分数', r1.rules.length > 0 && typeof r1.rules[0].score === 'number')

  // 8) 标签推断
  const strict = tags.tagsOfStrict({ key: 'style.ppt.minimal_tech.density', title: '极简科技风信息密度', value: '', category: 'style' })
  check('key/title 推断出 ppt 标签', strict.includes('ppt'), strict.join(','))

  // 9) 适用面（coverage）：分类表 → 默认/局部注入分流 → 路由按域过滤
  const covMod = await import(pathToFileURL(path.join(here, '..', 'scripts', 'coverage-map.mjs')).href)
  const sampleKeys = ['paths.downloads', 'style.ppt.text_density', 'workflow.office_verify', 'workflow.tdd_red_first', 'bili_whale.share_via', 'model.schedule_window']
  const { map, missing } = covMod.buildCoverage(sampleKeys)
  check('分类表覆盖代表性 key（无未分类）', missing.length === 0, missing.join(','))
  check('分类表含默认与局部两类', Object.values(map).some((x) => x.coverage === 'default') && Object.values(map).some((x) => x.coverage === 'local'))
  check('局部域按前缀归类正确', map['style.ppt.text_density'].appliesTo.includes('ppt') && map['workflow.office_verify'].appliesTo.includes('office'))
  fs.mkdirSync(path.join(tmp, '.dsh', 'rules'), { recursive: true })
  fs.writeFileSync(store.COVERAGE_FILE, JSON.stringify({ version: 1, domains: covMod.DOMAINS, map }), 'utf8')

  store.upsertRule({ key: 'selftest.default_rule', value: 'y', title: '应常驻出现ABC', category: 'workflow', coverage: 'default' }, { sync: false })
  store.upsertRule({ key: 'selftest.local_rule', value: 'x', title: '只应局部出现XYZ', category: 'workflow', coverage: 'local', appliesTo: ['ppt'] }, { sync: false })
  store.upsertRule({ key: 'selftest.ppt_rule', value: 'pptx 每页 2 个要点', title: 'PPT 局部规则示例', category: 'style', coverage: 'local', appliesTo: ['ppt'] }, { sync: false })
  const withCov = store.loadRules()
  const covCounts = store.coverageCounts(withCov)
  check('读入后每条都有 coverage', withCov.every((r) => r.coverage === 'default' || r.coverage === 'local'))
  check('默认/局部计数非零', covCounts.default > 0 && covCounts.local > 0, JSON.stringify(covCounts))
  const dig2 = store.renderDigest(withCov)
  check('默认规则进常驻摘要', dig2.includes('应常驻出现ABC'))
  check('局部规则不进常驻摘要', !dig2.includes('只应局部出现XYZ'))
  const localSaved = withCov.find((r) => r.key === 'selftest.local_rule')
  check('局部规则保存 appliesTo', (localSaved?.appliesTo || []).includes('ppt'))
  check('摘要头部说明局部规则数', /局部规则 \d+ 条/.test(dig2), dig2.split('\n')[2]?.slice(0, 60))

  const rPpt = routing.routeTask('做一份季度汇报 PPT')
  check('路由结果分默认/局部两组', Array.isArray(rPpt.defaultRules) && Array.isArray(rPpt.localRules))
  check('PPT 任务命中 ppt 域局部规则', rPpt.localRules.some((x) => x.coverage === 'local' && (x.appliesTo || []).includes('ppt')))
  const rPaper = routing.routeTask('写一篇 GB7714 论文')
  check('论文任务不给 blender 局部规则', !rPaper.localRules.some((x) => (x.appliesTo || []).includes('blender')))
  store.removeRule('selftest.default_rule')
  store.removeRule('selftest.local_rule')
  store.removeRule('selftest.ppt_rule')

  // 10) 适用面推断与「不静默默认」（coverage v2）
  const cov = await import(lib('coverage.js'))
  const inferredExplicit = cov.inferCoverage({ key: 'x.y', coverage: 'local', appliesTo: ['ppt'] }, {})
  check('显式覆盖优先（置信 1）', inferredExplicit.coverage === 'local' && inferredExplicit.confidence === 1 && !inferredExplicit.needsReview)
  const inferredMap = cov.inferCoverage({ key: 'style.ppt.text_density', category: 'style' }, { map: { 'style.ppt.text_density': { coverage: 'local', appliesTo: ['ppt'] } } })
  check('分类表命中（置信 0.9）', inferredMap.coverage === 'local' && inferredMap.appliesTo.includes('ppt') && inferredMap.confidence === 0.9)
  const inferredKeyword = cov.inferCoverage({ key: 'custom.slides_hint', title: 'PPT 排版建议', category: 'style' }, {})
  check('关键词推断出任务域', inferredKeyword.coverage === 'local' && inferredKeyword.appliesTo.includes('ppt') && inferredKeyword.confidence <= 0.75)
  const inferredCatDefault = cov.inferCoverage({ key: 'custom.path', category: 'paths' }, {})
  check('通用类别兜底为 default', inferredCatDefault.coverage === 'default' && !inferredCatDefault.needsReview)
  const inferredFallback = cov.inferCoverage({ key: 'custom.weird_thing', value: '某个说不清用途的准则', category: 'style' }, {})
  check('说不清的规则进待复核（不静默当正确）', inferredFallback.needsReview === true)
  check('兜底更保守：判局部（不默认生效）且空任务域', inferredFallback.coverage === 'local' && inferredFallback.appliesTo.length === 0)

  store.upsertRule({ key: 'selftest.review_me', value: '含糊的准则', category: 'style' }, { sync: false })
  const withReview = store.loadRules()
  check('store 给规则带上 needsReview', withReview.find((r) => r.key === 'selftest.review_me')?.needsReview === true)
  check('待复核队列可列出并带建议', store.coverageReview(withReview).some((x) => x.key === 'selftest.review_me' && x.suggestion))
  check('摘要对未确定项显式提示', /待复核/.test(store.renderDigest(withReview)))
  const acc = store.acceptCoverageSuggestions({ minConfidence: 0.2 })
  check('accept 落定建议并保留来源标记', acc.accepted >= 1 && store.loadRules().find((r) => r.key === 'selftest.review_me')?.coverageSource === 'review')
  check('落定后移出待复核队列', !store.coverageReview(store.loadRules()).some((x) => x.key === 'selftest.review_me'))
  store.removeRule('selftest.review_me')

  // 11) 来源闸口（新技能/新来源登记）
  const skillsDir = path.join(tmp, '.dsh', 'skills', 'gate-skill')
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# gate skill\n', 'utf8')
  const sources = await import(lib('sources.js'))
  const all = sources.discoverSources()
  const gateSkill = all.find((s) => s.kind === 'user-skill' && s.name === 'gate-skill')
  check('能发现用户技能目录', Boolean(gateSkill))
  const g1 = sources.checkSources()
  check('新技能在台账里标记为 new', g1.new.some((s) => s.name === 'gate-skill'))
  sources.recordSources({ harvested: all.map((s) => s.id) })
  const g2 = sources.checkSources()
  check('登记后不再报 new', !g2.new.some((s) => s.name === 'gate-skill'))
  fs.appendFileSync(path.join(skillsDir, 'SKILL.md'), '\nmore text\n', 'utf8')
  const g3 = sources.checkSources()
  check('技能内容变化后报 changed', g3.changed.some((s) => s.name === 'gate-skill'))
  const plan = sources.harvestPlan()
  check('采集计划给出 new/changed 列表', Array.isArray(plan.new) && Array.isArray(plan.changed) && plan.changed.some((s) => s.name === 'gate-skill'))
  fs.rmSync(skillsDir, { recursive: true, force: true })
  const g4 = sources.checkSources()
  check('技能被删后报 removed', g4.removed.some((s) => s.name === 'gate-skill'))
  const ledgerRaw = JSON.parse(fs.readFileSync(path.join(tmp, '.dsh', 'rules', 'sources.json'), 'utf8'))
  check('台账落盘且有指纹', Boolean(ledgerRaw.sources) && Object.values(ledgerRaw.sources).every((v) => v.fingerprint))

  // 11.2) 不假设安装位置：自定义根 / 忽略 / 插件包内 SKILL.md / runtime 环境变量
  const customDir = path.join(tmp, 'my-custom-skills', 'weird-skill')
  fs.mkdirSync(customDir, { recursive: true })
  fs.writeFileSync(path.join(customDir, 'SKILL.md'), '# custom\n', 'utf8')
  sources.addRoot('custom-skill', path.join(tmp, 'my-custom-skills'))
  check('自定义根被发现', sources.discoverSources({ force: true }).some((s) => s.kind === 'custom-skill' && s.name === 'weird-skill'))
  sources.addIgnore('weird-skill')
  check('忽略规则生效', !sources.discoverSources({ force: true }).some((s) => s.name === 'weird-skill'))
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.dsh', 'rules', 'sources.config.json'), 'utf8'))
  check('自定义根/忽略落盘', cfg.extraRoots.length >= 1 && cfg.ignore.includes('weird-skill'))

  // 插件包：<profile>/node_modules/<pkg>/任意深度/SKILL.md
  const pkgSkill = path.join(tmp, '.dsh', 'profiles', 'desktop', 'node_modules', 'demo-plugin', 'presets', 'x', 'skills', 'demo-skill')
  fs.mkdirSync(pkgSkill, { recursive: true })
  fs.writeFileSync(path.join(pkgSkill, 'SKILL.md'), '# demo\n', 'utf8')
  const all2 = sources.discoverSources({ force: true })
  check('插件包内任意深度 SKILL.md 被发现', all2.some((s) => s.kind === 'plugin-skill' && s.name === 'demo-plugin/demo-skill'))

  // runtime 技能根可由环境变量指定（跨用户/跨平台不写死）
  const rtSkills = path.join(tmp, 'runtime-skills')
  fs.mkdirSync(path.join(rtSkills, 'rt-skill'), { recursive: true })
  fs.writeFileSync(path.join(rtSkills, 'rt-skill', 'SKILL.md'), '# rt\n', 'utf8')
  process.env.DSH_RUNTIME_SKILLS = rtSkills
  check('runtime 技能根可用环境变量指定', sources.discoverSources({ force: true }).some((s) => s.kind === 'runtime-skill' && s.name === 'rt-skill'))
  delete process.env.DSH_RUNTIME_SKILLS
  check('来源根清单可读', sources.sourceRootSummary().roots.length >= 2 && Boolean(sources.sourceRootSummary().configFile))

  // 12) 技能导入 + 一句话起草 + 助手会话
  const skill = await import(lib('skill-import.js'))
  const asst = await import(lib('assistant.js'))
  const fakeSkill = path.join(tmp, 'downloads', 'my-fancy-skill')
  fs.mkdirSync(path.join(fakeSkill, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(fakeSkill, 'SKILL.md'), '# My Fancy Skill\n\n- 安装时用 `npm i -g foo` 并校验 SHA256\n- 超时时间设为 30 秒\n- 这一步没有任何硬参数\n', 'utf8')
  fs.writeFileSync(path.join(fakeSkill, 'scripts', 'run.js'), '// x\n', 'utf8')
  const inspected = skill.inspectSkill(fakeSkill)
  check('能检查出缺 frontmatter', inspected.hasSkillMd && inspected.warnings.some((w) => /frontmatter/.test(w)))
  const installed = skill.installSkill(fakeSkill, { name: 'fancy-demo' })
  check('技能安装到 DSH 技能目录', installed.installed.includes(path.join('.dsh', 'skills', 'fancy-demo')) && fs.existsSync(path.join(installed.installed, 'SKILL.md')))
  const installedMd = fs.readFileSync(path.join(installed.installed, 'SKILL.md'), 'utf8')
  check('自动补 frontmatter（name/description）', /^---\nname: fancy-demo\ndescription: /m.test(installedMd))
  const drafts = skill.draftRulesFromSkill(installed.installed)
  check('从技能提取候选准则', drafts.length >= 2 && drafts.every((d) => d.status === 'pending' && d.key.includes('.')))
  check('不含硬参数的条目不提取', !drafts.some((d) => d.value.includes('没有任何硬参数')))
  let dupErr = ''
  try { skill.installSkill(fakeSkill, { name: 'fancy-demo' }) } catch (e) { dupErr = e.message }
  check('同名技能默认不覆盖', /已存在/.test(dupErr))
  check('overwrite 可覆盖', Boolean(skill.installSkill(fakeSkill, { name: 'fancy-demo', overwrite: true }).installed))

  const dft = skill.draftRuleFromText('帮我记一条准则：以后下载模型统一放 D:/models，先用便携版')
  check('一句话起草去掉引导语', dft.value.startsWith('以后下载模型') && dft.category === 'install')
  check('起草默认 pending', dft.status === 'pending' && dft.key.startsWith('install.'))

  const prompt = asst.buildAssistantPrompt('我下载了一个技能在 D:/x')
  check('助手提示词带工具指引', prompt.includes('skill_import') && prompt.includes('rules_draft') && prompt.includes('D:/x'))
  const ev = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '时间上下文' }], source: { kind: 'time-context' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '在，请说' }] } } },
  ]
  const chat = asst.extractChat(ev)
  check('会话提取跳过 reasoning/时间上下文', chat.messages.length === 2 && chat.messages[1].text === '在，请说')
  let noCtrl = ''
  try { await asst.sendToAssistant(null, 'hi') } catch (e) { noCtrl = e.message }
  check('无 sessionController 时给出明确错误', /sessionController/.test(noCtrl))
  const calls = []
  const stub = { create: async (a) => calls.push(['create', a.sessionId]), prompt: async (a) => calls.push(['prompt', a.sessionId, a.content?.[0]?.text]) }
  const sent = await asst.sendToAssistant(stub, '我下载了一个技能', { sessionId: 'test-assistant-1', cwd: tmp })
  check('能投递到会话（create+prompt）', sent.sessionId === 'test-assistant-1' && calls.some((c) => c[0] === 'prompt'))
  check('投递内容带用户原文', calls.find((c) => c[0] === 'prompt')[2].includes('我下载了一个技能'))
  asst.resetAssistant()
  check('可重置助手会话', !asst.getAssistantState())

  // 13) 流程拓扑：单条准则 → 完整流程（按阶段 + 顺序边）
  const topo = await import(lib('topology.js'))
  store.upsertRule({ key: 'proj.setup', value: '装到 D:/apps', category: 'install', source: 'proj:demo' }, { sync: false })
  store.upsertRule({ key: 'proj.tools', value: '用便携版工具', category: 'tools', source: 'proj:demo' }, { sync: false })
  store.upsertRule({ key: 'proj.style', value: '输出用简洁风格', category: 'style', source: 'proj:demo' }, { sync: false })
  const rulesForTopo = store.loadRules()
  const t1 = topo.buildTopology(rulesForTopo, 'proj.tools')
  check('同来源归为一条流程', Boolean(t1) && t1.basis === 'source' && t1.total === 3)
  check('按阶段排序（环境→工具→风格）', t1.stages.map((s) => s.id).join(',') === 'setup,tools,output')
  check('当前项被标记', t1.stages.find((s) => s.id === 'tools').items.some((i) => i.current && i.key === 'proj.tools'))
  check('有顺序边', t1.edges.some((e) => e.kind === 'stage') && t1.edges.length >= 2)
  check('整套来源识别为 package', t1.kind === 'package' && t1.kindLabel === '整套流程')
  check('入口/结果有值', Boolean(t1.entry && t1.entry.key && t1.exit && t1.exit.key))
  check('找不到 key 返回 null', topo.buildTopology(rulesForTopo, 'no.such.key') === null)
  store.removeRule('proj.setup'); store.removeRule('proj.tools'); store.removeRule('proj.style')

  // 零散学习：manual 来源 → scattered
  store.upsertRule({ key: 'scat.one', value: '一条零散准则', category: 'workflow', source: 'manual' }, { sync: false })
  store.upsertRule({ key: 'scat.two', value: '另一条零散准则', category: 'workflow', source: 'manual' }, { sync: false })
  const tScat = topo.buildTopology(store.loadRules(), 'scat.one')
  check('零散来源识别为 scattered', Boolean(tScat) && tScat.kind === 'scattered' && tScat.kindLabel === '零散学习')
  check('零散学习提示无固定流程', /没有固定流程/.test(tScat.note))
  store.removeRule('scat.one'); store.removeRule('scat.two')

  // 14) 模糊搜索（拼写容错 / 字符顺序 / 多词）
  const search = await import(lib('search.js'))
  check('拼写错误能命中（blander→blender）', search.fuzzyHit('blander', 'Blender 5.0 建模'))
  check('完全匹配能命中', search.fuzzyHit('blender', 'Blender 5.0 建模'))
  check('无关词不命中', !search.fuzzyHit('xyz', 'Blender 5.0 建模'))
  check('中文子串能命中', search.fuzzyHit('建模', 'blender 建模流程'))
  check('相邻字符互换算 1 步（mdoel→model）', search.editDistance('mdoel', 'model') === 1)
  check('多词都需命中', search.fuzzyHit('path download', 'path.downloads 下载默认目录') && !search.fuzzyHit('path zzz', 'path.downloads 下载默认目录'))
  check('打分排序：完全包含 > 拼错', search.fuzzyScore('blender', 'blender 建模') > search.fuzzyScore('blander', 'blender 建模'))
  {
    const raw = fs.readFileSync(new URL('../lib/search.js', import.meta.url), 'utf8')
    const classic = raw.replace(/^export\s+function\s+/gm, 'function ').replace(/^export\s+/gm, '')
    let compiles = true
    try { new Function(classic + '\nreturn { fuzzyHit: fuzzyHit }') } catch { compiles = false }
    check('浏览器版 search.js 可编译且无 export 残留', compiles && !/^export\s/m.test(classic))
  }

  // 15) 白话解释字段（explain）：能存、能清空
  store.upsertRule({ key: 'demo.explain', value: '短', explain: '这条是给完全不懂的人看的解释：意思是先这样再那样。', category: 'workflow', source: 'manual' }, { sync: false })
  const ex1 = store.loadRules().find((r) => r.key === 'demo.explain')
  check('规则能保存白话解释 explain', Boolean(ex1) && /完全不懂/.test(ex1.explain || ''))
  store.upsertRule({ key: 'demo.explain', value: '短', explain: '', category: 'workflow', source: 'manual' }, { sync: false })
  const ex2 = store.loadRules().find((r) => r.key === 'demo.explain')
  check('解释清空后不落盘', Boolean(ex2) && !ex2.explain)
  store.removeRule('demo.explain')

  // 17) 改动记录：新增 / 修改 / 删除都记录，能按 key 过滤、按时间倒序
  store.upsertRule({ key: 'hist.demo', title: '记录测试', value: '第一版', category: 'workflow', source: 'manual' }, { sync: false })
  store.upsertRule({ key: 'hist.demo', title: '记录测试', value: '第二版', category: 'workflow', source: 'manual' }, { sync: false })
  store.removeRule('hist.demo')
  const hist = store.loadHistory({ key: 'hist.demo', limit: 10 })
  check('改动记录有 3 条（增/改/删）', hist.length === 3 && hist[0].action === 'remove' && hist[1].action === 'update' && hist[2].action === 'create')
  const up = hist.find((e) => e.action === 'update')
  check('改动记录含「由什么改成什么」', Boolean(up) && up.changes.some((c) => c.field === 'value' && c.from === '第一版' && c.to === '第二版'))
  check('可按 key 过滤', store.loadHistory({ key: 'hist.demo' }).length === 3 && store.loadHistory({ key: 'nope.key' }).length === 0)
  check('记录按时间倒序', hist[0].at >= hist[hist.length - 1].at)

  // 18) 本对话默认（会话默认域）：设定 / 生效标记 / 会话隔离 / 清除 / 未知域拒绝
  store.upsertRule({ key: 'sess.ppt.demo', value: 'PPT 会话规则', category: 'style', source: 'test', coverage: 'local', appliesTo: ['ppt'] }, { sync: false })
  const stag = 'selftest-session-1'
  store.setSessionProfile(stag, { domain: 'ppt', label: '测试窗口' })
  check('会话默认能设定并能读回', store.loadSessionProfile(stag)?.domain === 'ppt')
  const effSess = store.resolveEffective(store.loadRules(), { session: stag })
  check('会话内该域规则被当默认（标记 sessionDefault）', effSess.some((r) => r.key === 'sess.ppt.demo' && r.sessionDefault === true))
  const effOther = store.resolveEffective(store.loadRules(), { session: 'selftest-other' })
  check('其它会话不受影响', !effOther.some((r) => r.sessionDefault))
  let badDomain = false
  try { store.setSessionProfile(stag, { domain: 'not-a-domain' }) } catch { badDomain = true }
  check('未知任务域被拒绝', badDomain)
  check('会话默认可清除', store.clearSessionProfile(stag) && !store.loadSessionProfile(stag))
  // 18b) 按条翻「本对话生效」：pin / 只在 pin 的会话生效 / unpin
  store.upsertRule({ key: 'sess.paper.demo', value: '论文会话规则', category: 'style', source: 'test', coverage: 'local', appliesTo: ['paper'] }, { sync: false })
  const ptag = 'selftest-pin-1'
  store.pinSessionRules(ptag, ['sess.ppt.demo'], true)
  const pinEff = store.resolveEffective(store.loadRules(), { session: ptag })
  check('按条 pin 的局部规则在本会话生效', pinEff.some((r) => r.key === 'sess.ppt.demo' && r.sessionDefault === true) && !pinEff.some((r) => r.key === 'sess.paper.demo' && r.sessionDefault === true))
  store.pinSessionRules(ptag, ['sess.ppt.demo'], false)
  check('unpin 后不再本会话生效', !store.resolveEffective(store.loadRules(), { session: ptag }).some((r) => r.key === 'sess.ppt.demo' && r.sessionDefault === true))
  store.clearSessionProfile(ptag)
  store.removeRule('sess.ppt.demo')
  store.removeRule('sess.paper.demo')

  // 16) 多步撤回：移动可撤回，且能连续撤回多步
  const sid = tree.listSchemes()[0].id
  const nA = tree.addNode({ schemeId: sid, title: '撤回测试A' })
  const nB = tree.addNode({ schemeId: sid, title: '撤回测试B' })
  check('增删改前会压撤回栈（>=2 步）', tree.undoCount() >= 2)
  tree.moveRule({ schemeId: sid, key: 'undo.demo', nodeId: nA.id })
  const u1 = tree.undoLast()
  const placements = tree.getScheme(sid).placements || {}
  check('移动可撤回（规则归属恢复）', placements['undo.demo'] === undefined && u1.remaining >= 1)
  tree.undoLast()
  const view = tree.schemeView(tree.getScheme(sid), [])
  const findNode = (ns, id) => ns.some((n) => n.id === id || findNode(n.children || [], id))
  check('能连续撤回两步（节点 B 也撤销）', !findNode(view.roots, nB.id))
  tree.undoLast()
  const view2 = tree.schemeView(tree.getScheme(sid), [])
  check('继续撤回第三步（节点 A 撤销）', !findNode(view2.roots, nA.id))
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${passed} 通过，${fails.length} 失败`)
if (fails.length) { console.error('失败项：\n- ' + fails.join('\n- ')); process.exit(1) }
