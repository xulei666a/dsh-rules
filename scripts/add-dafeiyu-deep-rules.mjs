import fs from 'node:fs'
import * as store from '../lib/store.js'
import * as tree from '../lib/tree.js'

const SRC = '大肥鱼样例深层分析 2026-11-01'
const RULES = [
  {
    key: 'video.dafeiyu.entry_staging',
    title: '大肥鱼式：入场分层',
    value: '切点前 2 帧出画卡 scale 1.00→1.04 + blur 1.5px；切点当帧 1 帧白闪（亮度 +45~60%），同时硬切背景主色、标题卡、字幕、ticker、角色姿态；图标/Logo 延迟 0.2-0.4s 弹入（scale 0.5→1.05→1.0，过冲 5%，100-150ms）；次级纹理/代码墙 0.3-1.0s 生长；重点卡数字 count-up 0.8-1.0s。主要元素入场稳定时间 0.10-0.30s。',
  },
  {
    key: 'video.dafeiyu.hold_motion',
    title: '大肥鱼式：hold 期持续微动',
    value: '卡片 hold 不是静止：实测帧差基线 0.02-0.07（不是 0.001）。角色每卡换 0-3 次姿态、持续 0.2-1.0px/帧（1080 基准）极慢漂移 + 眨眼；闪粉/粒子每帧闪烁；图标 <1px 浮动；背景放射线本身静止（光流 ≈0°/s），不要靠转放射线制造动感；数字/代码墙可余动。',
  },
  {
    key: 'video.dafeiyu.audio_state',
    title: '大肥鱼式：声音状态',
    value: 'BGM 连续床垫：底噪约 -21 dB，人声约 -14 dB（差 7dB），峰值 -5.5 dB；切点精确落在旁白词首（中位 -0.05s，±0.15s 内 16/18），不是 BGM 拍点；大多数切点没有 whoosh（高频瞬态中位 0.81-0.83），只在 2-4 个重点卡加 hit/爆点音效；切点后低频能量升约 1.5× 是人声起句，不要误加 duck。',
  },
]
for (const r of RULES) {
  store.upsertRule({ ...r, tags: ['animation', 'video'], category: 'workflow', coverage: 'local', appliesTo: ['animation'], status: 'active', source: SRC }, { sync: false })
}
const schemeId = 'default'
const scheme = tree.getScheme(schemeId)
const find = (nodes, title) => {
  for (const n of nodes || []) { if (n.title === title) return n; const h = find(n.children, title); if (h) return h }
  return null
}
const A = find(scheme.nodes, '流程A · 大肥鱼竖屏科普')
if (!A) throw new Error('流程A 文件夹丢失')
for (const r of RULES) tree.moveRule({ schemeId, key: r.key, nodeId: A.id })
console.log('added', RULES.length, 'rules to A')
