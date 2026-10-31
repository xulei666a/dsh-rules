/**
 * dsh-rules · 标签推断
 *
 * 每条规则可带显式 tags；不填时从 key/title/value 推断。
 * 「强标签」只看 key/title（用于分类树自动归类），「弱标签」含 value（用于搜索/展示）。
 * 分类树本身见 lib/tree.js。
 */
const TAG_RULES = [
  ['ppt', /ppt|幻灯片|slides?|deck|演示|演讲|html-ppt/i],
  ['paper', /论文|paper|期刊|gb\/?t|gb7714|学术|citation|学位论文|投稿/i],
  ['report', /报告|周报|月报|report|concise/i],
  ['diagram', /图表|diagram|svg|架构图|流程图|示意图|可视化/i],
  ['office', /office|docx|pptx|xlsx|word|excel|powerpoint|libreoffice|工作簿|spreadsheet|presentation/i],
  ['blender', /blender|3d|glb|gltf|pbr|渲染|建模|材质|灯光|相机|uv|拓扑/i],
  ['animation', /动画|动效|转场|motion|帧率|mp4/i],
  ['image', /图片|图像|截图|照片|渲染图|image|modlens|png|jpg|画面|视觉/i],
  ['video', /视频|video|录屏|录制|字幕|剪辑|ffmpeg|摄影/i],
  ['coding', /tdd|测试|评审|review|调试|debug|bug|架构|模块|seam|spec|ticket|triage|git|重构|原型|repo|smell/i],
  ['safety', /安全|红线|脱敏|不可逆|凭据|密钥|隐私|破坏性|hard.risk|redact/i],
  ['memory', /AGENTS|EXPERIENCE|经验|校准|维护|过期|源头|lesson|cue|skill-vet/i],
  ['skill', /技能|skill|插件|plugin|mcp|cordis|prompt|harness/i],
  ['install', /安装|下载|镜像|代理|校验|sha256|portable|gh-proxy|npmmirror/i],
  ['model', /余额|预算|计价|峰谷|低谷|token|成本|deepseek/i],
  ['communication', /回答|回复|汇报方式|沟通|中文|简洁|结论先行|语气|人设|persona|派活/i],
]

/** 给单条规则算标签（显式 tags + 推断；含 value） */
export function tagsOf(rule) {
  const text = [rule.key, rule.title, rule.value, rule.category].filter(Boolean).join(' ')
  const out = new Set(Array.isArray(rule.tags) ? rule.tags : [])
  for (const [tag, re] of TAG_RULES) if (re.test(text)) out.add(tag)
  if (rule.category) out.add(rule.category)
  return [...out]
}

/** 强标签：只看 key + title（避免 value 里顺带提到某个词就被打标） */
export function tagsOfStrict(rule) {
  const text = [rule.key, rule.title, rule.category].filter(Boolean).join(' ')
  const out = new Set(Array.isArray(rule.tags) ? rule.tags : [])
  for (const [tag, re] of TAG_RULES) if (re.test(text)) out.add(tag)
  if (rule.category) out.add(rule.category)
  return [...out]
}
