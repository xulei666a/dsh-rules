/* 把「视频流程」做成真正的决策点：清掉旧演示决策，给 A/B 两个流程文件夹设 video.workflow */
import fs from 'node:fs'
import * as tree from '../lib/tree.js'

const home = process.env.USERPROFILE || 'C:/Users/27393'
const groups = home + '/.dsh/rules/groups.json'
const bak = groups + '.bak-workflow-decision-' + new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(groups, bak)
console.log('backup:', bak)

const schemeId = 'default'
let scheme = tree.getScheme(schemeId)
const find = (nodes, title) => {
  for (const n of nodes || []) {
    if (n.title === title) return n
    const hit = find(n.children, title)
    if (hit) return hit
  }
  return null
}
const oldVideo = find(scheme.nodes, '视频制作')
const oldNew = find(scheme.nodes, '新视频制作')
if (oldVideo) tree.setNodeDecision({ schemeId, nodeId: oldVideo.id, decision: '', option: '' })
if (oldNew) tree.setNodeDecision({ schemeId, nodeId: oldNew.id, decision: '', option: '' })

scheme = tree.getScheme(schemeId)
const A = find(scheme.nodes, '流程A · 大肥鱼竖屏科普')
const B = find(scheme.nodes, '流程B · MG15 风格片')
if (!A || !B) throw new Error('找不到流程文件夹')
tree.setNodeDecision({ schemeId, nodeId: A.id, decision: 'video.workflow', option: 'A · 大肥鱼竖屏科普' })
tree.setNodeDecision({ schemeId, nodeId: B.id, decision: 'video.workflow', option: 'B · MG15 风格片' })

const after = tree.getScheme(schemeId)
const chk = (nodes) => {
  for (const n of nodes || []) {
    if (n.decision) console.log('decision:', n.title, '->', n.decision, '|', n.option)
    chk(n.children)
  }
}
chk(after.nodes)
