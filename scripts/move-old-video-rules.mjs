/* 把视频制作里的旧采集/旧流程规则收进「历史流程（v2/v3）」子文件夹，只留 3 条通用 + A/B 流程 */
import fs from 'node:fs'
import * as store from '../lib/store.js'
import * as tree from '../lib/tree.js'

const home = process.env.USERPROFILE || 'C:/Users/27393'
const groups = home + '/.dsh/rules/groups.json'
const bak = groups + '.bak-history-move-' + new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(groups, bak)
console.log('backup:', bak)

const schemeId = 'default'
const scheme = tree.getScheme(schemeId)
const rules = store.loadRules()
const find = (nodes, title) => {
  for (const n of nodes || []) {
    if (n.title === title) return n
    const h = find(n.children, title)
    if (h) return h
  }
  return null
}
const video = find(scheme.nodes, '视频制作')
if (!video) throw new Error('找不到 视频制作')
const direct = tree.rulesOfNode(scheme, rules, video.id, { includeDescendants: false })
const old = direct.filter((r) => !r.key.startsWith('video.pipeline.'))
console.log('direct rules:', direct.length, '| move to history:', old.length)

let hist = find(scheme.nodes, '历史流程（v2/v3）')
if (!hist) {
  hist = tree.addNode({ schemeId, parentId: video.id, title: '历史流程（v2/v3）', desc: '早期采集的动效/配音流水线与旧流程；保留备查，新任务优先用流程A/B' })
}
if (!hist) throw new Error('历史文件夹创建失败')
for (const r of old) tree.moveRule({ schemeId, key: r.key, nodeId: hist.id })
console.log('moved:', old.length, '->', hist.id)
