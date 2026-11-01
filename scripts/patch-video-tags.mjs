import fs from 'node:fs'
const root = 'D:/Agent/ai_engine/plugins/dsh-rules'
// 1) tags.js
let t = fs.readFileSync(root + '/lib/tags.js', 'utf8')
const oldTag = "['animation', /动画|动效|转场|motion|帧率|mp4/i],"
const newTag = "['animation', /动画|动效|转场|motion|帧率|mp4|竖屏|科普|花字|信息卡|配音|逐帧|大肥鱼|vlog|mg动画/i],"
if (!t.includes(oldTag)) throw new Error('tags anchor not found')
t = t.replace(oldTag, newTag)
fs.writeFileSync(root + '/lib/tags.js', t, 'utf8')
// 2) routing.js
let r = fs.readFileSync(root + '/lib/routing.js', 'utf8')
const oldHint = "  animation: ['动画', '动效', '视频', '短片', '逐帧', '转场', 'motion'],"
const newHint = "  animation: ['动画', '动效', '视频', '短片', '逐帧', '转场', 'motion', '竖屏', '科普', '花字', '信息卡', '配音', '大肥鱼', 'mg', 'vlog'],"
if (!r.includes(oldHint)) throw new Error('routing anchor not found')
r = r.replace(oldHint, newHint)
fs.writeFileSync(root + '/lib/routing.js', r, 'utf8')
console.log('tags/routing patched')
