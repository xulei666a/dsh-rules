/* 把从样例学到的两套视频流程写进统一准则库 + 分类树 */
import * as store from '../lib/store.js'
import * as tree from '../lib/tree.js'

const SRC = '视频流程库 2026-11-01（样例拆解）'
const RULES = [
  // —— 通用（放在「视频制作」文件夹本身） ——
  {
    key: 'video.pipeline.template_choice',
    title: '视频任务先选流程',
    value: '先判断类型再动手：信息型/栏目化/工具盘点 → 大肥鱼式竖屏模板（1080x1920@30，固定版式换卡，旁白整段，3-4s/信息点）；单支品牌/风格样片/片头 → MG-STYLES-15 流程（10.00s 整，24/30fps，代码渲染+代码音频，AI 评审两轮）。插件/产品介绍可用 A 的竖屏结构 + B 的 3-5s hero 片头。',
  },
  {
    key: 'video.pipeline.single_take_tts',
    title: '旁白整段一次生成',
    value: '旁白必须整段一次 TTS（单次 ≤120s）；超过 120s 才分段，但每段必须固定 speaker 参考音色。严禁逐句 TTS 拼接——逐句会换音色/语气，成片像换人（本项目实测 10 句拼接出现 3 种音色）。',
  },
  {
    key: 'video.pipeline.frame_qa',
    title: '成片 QA 看接触表+关键帧',
    value: '成片后先出接触表（每 2-5s 一帧/tile）看节奏与整体，再按段中点抽全分辨率关键帧查：字幕溢出、叠字、缺字形（CJK/符号）、角色遮挡、空帧；同时 volumedetect 查响度（-14~-16 LUFS，TP≤-1）。渲染前先抽 8-10 帧 preview 再全量。',
  },
  // —— 流程 A ——
  {
    key: 'video.dafeiyu.format',
    title: '大肥鱼式：画布与节奏',
    value: '1080x1920@30fps，H.264+AAC；时长 45-220s 按信息量走，不刻意压缩。固定四层版式：顶部 ticker / 信息卡区(y 15-38%) / 常驻角色区(y 50-100%) / 字幕区(y 66-76%)。每个信息点 2.5-4s，一卡只讲一件事，标题即结论（≤12 字）。',
  },
  {
    key: 'video.dafeiyu.layout',
    title: '大肥鱼式：卡片与角色',
    value: '信息卡：彩色圆角标签(60-70px) + 图标/Logo(160-200px) + 主标题 52-68px 粗体白字深描边 + 副标题 24-30px；可嵌 UI 截图（圆角 16-24px）。角色：Q 版常驻下方，宽 700-900px，6-10 张状态图切换 + 1-2px 呼吸浮动，不做骨骼动画。背景：放射渐变+sunburst 慢转+粒子+暗角，按信息点换主色。',
  },
  {
    key: 'video.dafeiyu.typography',
    title: '大肥鱼式：字幕规范',
    value: '中文主字幕 ≤2 行、46-54px 白色粗体 + 6-8px 黑描边，压在角色胸口、不挡脸；英文副字幕 24-28px 白色 70%。字幕位置固定，随旁白逐行上浮，禁止压信息卡和角色头部。',
  },
  {
    key: 'video.dafeiyu.pipeline',
    title: '大肥鱼式：生产流程',
    value: '分卡脚本（每卡：标签/图标/标题/副标题/背景色/角色状态/截图）→ 素材表 → 整段 TTS（测句级起止）→ 搭固定模板（Canvas/DOM 分层）→ 逐卡动效（卡片弹性入 scale 0.92→1.02→1，120-200ms；图标弹跳；sunburst 慢转）→ 1080x1920@30 逐帧渲染 → 混音（BGM 压人声下约 -20dB，卡片 whoosh/pop）→ 抽帧 QA。',
  },
  // —— 流程 B ——
  {
    key: 'video.mg15.output',
    title: 'MG15：输出规格',
    value: '恰好 10.00s（24fps=240 帧 / 30fps=300 帧）；1920x1080（竖屏 1080x1920）；H.264+AAC 48k 立体声；响度 -14 LUFS ±1、true peak ≤-1 dBTP；无黑帧、无无意静帧；画面 hit 与音频 onset 对齐。',
  },
  {
    key: 'video.mg15.treatment',
    title: 'MG15：先写 Treatment',
    value: '动效前先写：0.5s 内钩子（不允许开场 >0.3s 黑屏/空镜）+ 升级 + 60-75% 处 hero moment + 0.8-1.2s 定格收尾；把 Signature features 逐条映射到时间点；产出一份 cue sheet（节拍与命中时间），画面和声音都读它。',
  },
  {
    key: 'video.mg15.keyframes',
    title: 'MG15：关键静帧先行',
    value: '动效前在 6-10 个关键时间点渲染静帧并逐张看：构图、层级、留白、字距/行高/字重、CJK 标点、四周约 5% 安全区；静帧必须像海报、不像模板/AI 生成，不过关不许进动效。动效低分辨率预览，最快动作逐帧查 spacing/easing/弧线/anticipation。',
  },
  {
    key: 'video.mg15.render',
    title: 'MG15：代码渲染管线',
    value: '每支片=一个网页，暴露 window.renderAt(t)，无头 Chrome 逐帧截图 → ffmpeg 合成音频与视频；3D 那支用 Blender 渲染序列帧 + 网页叠字。音频由 audio.py 合成（numpy/scipy/librosa/pedalboard），最后 loudnorm 到 -14 LUFS。参考实现：harness/render.mjs、harness/preview.html、lib/audio。',
  },
  {
    key: 'video.mg15.review',
    title: 'MG15：AI 评审两轮',
    value: '成片后另开 AI 按 rubric 评审：7 维 1-10 分（style_fidelity/concept_wow/motion_craft/design_typography/finish_texture/sound_sync/technical），先列 critical issues，再给 5-10 条按影响力排序的修改（带时间码与具体数值做法）；改完重渲再评一轮，目标每维 ≥9。',
  },
  {
    key: 'video.mg15.style_guide',
    title: 'MG15：15 种风格索引',
    value: '完整 15 风格索引、原片评分、技术路线见 D:\\Agent\\ai_engine\\video\\instructions\\02-mg-styles-15\\STYLE-INDEX.md；完整提示词在 styles/prompt-*.md（MIT）。选型：品牌/产品→3D渲染、玻璃拟态、液态；知识科普→粗描边贴纸、扁平矢量、线条；发布会/ident→形变、包豪斯、等轴；潮流/音乐→HUD、synthwave、像素、拼贴；竖屏综艺→花字；手作→逐帧手绘。',
  },
]

const schemeId = 'default'
const schemes = tree.loadSchemes()
const scheme = schemes.find((s) => s.id === schemeId) || schemes[0]
const findNode = (nodes, title) => {
  for (const n of nodes || []) {
    if (n.title === title) return n
    const hit = findNode(n.children, title)
    if (hit) return hit
  }
  return null
}
const parent = findNode(scheme.nodes, '视频制作')
if (!parent) throw new Error('找不到「视频制作」文件夹')
const sid = scheme.id

const nodeA = tree.addNode({ schemeId: sid, parentId: parent.id, title: '流程A · 大肥鱼竖屏科普', desc: '固定模板+角色IP；1080x1920@30，2.5-4s/信息点' })
const nodeB = tree.addNode({ schemeId: sid, parentId: parent.id, title: '流程B · MG15 风格片', desc: '10.00s 品牌级 MG；代码渲染+代码音频+AI评审两轮' })
if (!nodeA || !nodeB) throw new Error('建文件夹失败')

const A_KEYS = RULES.filter((r) => r.key.startsWith('video.dafeiyu')).map((r) => r.key)
const B_KEYS = RULES.filter((r) => r.key.startsWith('video.mg15')).map((r) => r.key)

for (const r of RULES) {
  store.upsertRule({
    ...r,
    category: 'workflow',
    coverage: 'local',
    appliesTo: ['animation'],
    status: 'active',
    source: SRC,
  }, { sync: false })
}
for (const key of A_KEYS) tree.moveRule({ schemeId: sid, key, nodeId: nodeA.id })
for (const key of B_KEYS) tree.moveRule({ schemeId: sid, key, nodeId: nodeB.id })
store.syncAgents?.({ force: false })
console.log('rules upserted:', RULES.length)
console.log('folders:', nodeA.id, '|', nodeB.id)
console.log('A keys:', A_KEYS.length, 'B keys:', B_KEYS.length)
