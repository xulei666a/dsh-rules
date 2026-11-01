/* 补充 MG15 的接口/音频/本机参考 3 条规则，并入流程B文件夹 */
import * as store from '../lib/store.js'
import * as tree from '../lib/tree.js'

const SRC = '视频流程库 2026-11-01（mg-styles-15 逆向报告）'
const RULES = [
  {
    key: 'video.mg15.contract',
    title: 'MG15：网页渲染契约',
    value: '每支片=一个网页：window.DEMO={width,height,fps,duration,motionBlur} + window.renderAt(t)（纯函数，只读 t 与 cues.json，禁止上一帧状态）+ window.__ready。渲染器会暂停所有 document.getAnimations() 并 currentTime=t*1000。命令：python3 demos/<slug>/audio.py → node harness/render.mjs demos/<slug>；开关 --stills/--mb/--scale/--crf/--tmap/--links/--workers。逐帧截图 → tmix 运动模糊 → ffv1 中间段 → x264 crf14 → AAC 320k。',
  },
  {
    key: 'video.mg15.audio_master',
    title: 'MG15：音频母带与音效',
    value: '母带：-14 LUFS integrated、真峰 ≤ -1 dBTP；hp=28Hz、<120Hz 单声道、glue comp ratio 2.0、fade 4ms/250ms。音乐总线 -20 LUFS；每个 SFX 命中前 55-95ms 把音乐预压 -9dB、命中帧回 0。采样用 CC0 乐器库（103 个 VCSL）；每支片 audio.py 输出 24-bit WAV、正好 10.000s。cues.json 同时喂画面与音频，禁用两套时间轴。',
  },
  {
    key: 'video.mg15.local_refs',
    title: 'MG15：本机参考与移植注意',
    value: '逆向报告 D:\\Agent\\ai_engine\\video\\例\\_analysis\\mg-styles-15.md（466 行）+ 100 文件镜像 _analysis/_repo/。可直接抄的引擎：demos/05-cel-boil/js/engine.js（变宽笔刷+simplex boil+套印偏移 REG={dx:-5,dy:4}+排线）、demos/02-line-art/film.js（弧长参数化+转角减速 KCORN=9/σ=7px）、demos/01-flat-vector/index.html L35-L58（6 个缓动函数）。Windows 移植需改 render.mjs 3 处（Chrome 路径、/tmp 锁目录、egl GPU 参数）；字体不在仓库（43 个需自备）。',
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
const B = find(scheme.nodes, '流程B · MG15 风格片')
if (!B) throw new Error('流程B 文件夹丢失')
for (const r of RULES) tree.moveRule({ schemeId, key: r.key, nodeId: B.id })
console.log('added', RULES.length, 'rules to', B.id)
