/**
 * dsh-rules · 本地语义嵌入（B 档，可选）
 *
 * 依赖装在 ~/.dsh/rules/embed/（独立 node_modules，不污染插件）：
 *   @xenova/transformers + 模型 Xenova/multilingual-e5-small（quantized，走 hf-mirror）
 * 不可用/未构建时全部函数抛错或返回 null，由调用方回退 A 档（标签+同义词+字符相似度）。
 *
 * 缓存：~/.dsh/rules/embeddings.json（按规则 key/updatedAt 增量重建，JSON 持久化）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { RULES_DIR } from './store.js'

export const MODEL = 'Xenova/multilingual-e5-small'
export const EMBED_DIR = path.join(RULES_DIR, 'embed')
export const CACHE_FILE = path.join(RULES_DIR, 'embeddings.json')
const CACHE_VERSION = 1

export function embeddingInstalled() {
  return fs.existsSync(path.join(EMBED_DIR, 'node_modules', '@xenova', 'transformers'))
}
export function embeddingsBuilt() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).version === CACHE_VERSION } catch { return false }
}

let pipePromise = null
async function getPipe() {
  if (pipePromise) return pipePromise
  pipePromise = (async () => {
    const bridgeFile = path.join(EMBED_DIR, 'package.json')
    if (!fs.existsSync(bridgeFile)) throw new Error('未安装 embedding 依赖（先运行 scripts/setup-embed.mjs）')
    const require = createRequire(bridgeFile)
    const entry = require.resolve('@xenova/transformers')
    const mod = await import(pathToFileURL(entry).href)
    const { pipeline, env } = mod
    env.cacheDir = path.join(EMBED_DIR, '.cache')
    env.allowLocalModels = false
    env.allowRemoteModels = true
    if (env.remoteHost !== undefined) env.remoteHost = 'https://hf-mirror.com'
    if (env.remotePathTemplate !== undefined) env.remotePathTemplate = '{model}/resolve/{revision}/'
    return await pipeline('feature-extraction', MODEL, { quantized: true })
  })()
  return pipePromise
}

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

async function embed(texts, kind) {
  const pipe = await getPipe()
  const prefixed = texts.map((t) => `${kind}: ${String(t).slice(0, 1200)}`)
  const out = await pipe(prefixed, { pooling: 'mean', normalize: true })
  return out.tolist()
}

function ruleText(r) {
  return [r.title, r.key, String(r.value).slice(0, 800)].filter(Boolean).join('；')
}

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (j.version === CACHE_VERSION && j.model === MODEL) return j
  } catch {}
  return { version: CACHE_VERSION, model: MODEL, updatedAt: null, vectors: {}, hashes: {} }
}

/** 确保规则库的向量是最新的（增量）；返回 {vectors, rebuilt, total} */
export async function ensureRuleEmbeddings(rules, { force = false, batch = 24, log = () => {} } = {}) {
  const cache = force ? { version: CACHE_VERSION, model: MODEL, updatedAt: null, vectors: {}, hashes: {} } : loadCache()
  const pending = []
  for (const r of rules) {
    const h = sha(ruleText(r) + '|' + r.updatedAt)
    if (cache.hashes[r.key] === h && cache.vectors[r.key]) continue
    pending.push({ r, h })
    delete cache.vectors[r.key]
    delete cache.hashes[r.key]
  }
  if (!pending.length) return { vectors: cache.vectors, rebuilt: 0, total: Object.keys(cache.vectors).length }
  for (let i = 0; i < pending.length; i += batch) {
    const chunk = pending.slice(i, i + batch)
    const vecs = await embed(chunk.map((x) => ruleText(x.r)), 'passage')
    chunk.forEach((x, j) => {
      cache.vectors[x.r.key] = vecs[j].map((v) => Number(v.toFixed(5)))
      cache.hashes[x.r.key] = x.h
    })
    log(`嵌入 ${Math.min(i + batch, pending.length)}/${pending.length}`)
  }
  cache.updatedAt = new Date().toISOString()
  fs.mkdirSync(RULES_DIR, { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8')
  return { vectors: cache.vectors, rebuilt: pending.length, total: Object.keys(cache.vectors).length }
}

const cos = (a, b) => {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

/** 领域锚点：每个内容领域一句话，任务与锚点做余弦 → 领域判定（比从规则标签投票稳） */
const DOMAIN_ANCHORS = {
  ppt: '制作一份 PPT 幻灯片演示文稿，给领导或客户汇报',
  paper: '撰写学术论文、期刊投稿、论文引用与格式',
  report: '写工作报告、周报、总结、季度汇报',
  diagram: '画图表、架构图、流程图、示意图、可视化',
  office: '编辑 Word、Excel、PowerPoint 文档并导出 PDF',
  blender: '用 Blender 做 3D 建模、材质、灯光、渲染并导出 GLB',
  animation: '制作动画、动效、短视频、逐帧渲染',
  coding: '写代码、修 bug、重构、写测试、代码评审',
  image: '处理图片、截图、照片、图像识别与取证',
}
const ANCHORS_FILE = path.join(RULES_DIR, 'domain-anchors.json')

export async function semanticDomainsByAnchors(task, { minScore = 0.55, gap = 0.04, cap = 3 } = {}) {
  let anchors = null
  try { anchors = JSON.parse(fs.readFileSync(ANCHORS_FILE, 'utf8')) } catch {}
  if (!anchors || anchors.model !== MODEL || !anchors.vectors) {
    const tags = Object.keys(DOMAIN_ANCHORS)
    const vecs = await embed(Object.values(DOMAIN_ANCHORS), 'query')
    anchors = { model: MODEL, version: CACHE_VERSION, vectors: {} }
    tags.forEach((t, i) => { anchors.vectors[t] = vecs[i].map((v) => Number(v.toFixed(5))) })
    fs.mkdirSync(RULES_DIR, { recursive: true })
    fs.writeFileSync(ANCHORS_FILE, JSON.stringify(anchors), 'utf8')
  }
  const [qv] = await embed([task], 'query')
  const scored = Object.entries(anchors.vectors).map(([tag, v]) => ({ tag, score: Number(cos(qv, v).toFixed(3)) })).sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score < minScore) return []
  return scored.filter((d) => d.score >= Math.max(minScore, top.score - gap)).slice(0, cap)
}

/** 语义检索：返回 [{rule, sim, score}]（score = 0.7*sim + 0.3*A 档字面分，需由调用方传入 scoreRule） */
export async function semanticSearch(task, rules, { topK = 12, scoreRule = null } = {}) {
  const { vectors } = await ensureRuleEmbeddings(rules)
  const [qv] = await embed([task], 'query')
  const rows = []
  for (const r of rules) {
    const v = vectors[r.key]
    if (!v) continue
    const sim = cos(qv, v)
    rows.push({ rule: r, sim, lexical: scoreRule ? scoreRule(r, task) : 0 })
  }
  return rows
    .map((x) => ({ ...x, score: 0.7 * x.sim + 0.3 * x.lexical }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** 任务 → 领域标签（用规则标签的 embedding 投票；缓存过规则向量） */
export async function semanticDomains(task, rules, tagFn, { topK = 3 } = {}) {
  const { vectors } = await ensureRuleEmbeddings(rules)
  const [qv] = await embed([task], 'query')
  const votes = new Map()
  for (const r of rules) {
    const v = vectors[r.key]
    if (!v) continue
    const sim = cos(qv, v)
    if (sim < 0.35) continue
    for (const t of tagFn(r)) votes.set(t, (votes.get(t) || 0) + sim)
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([tag, w]) => ({ tag, weight: Number(w.toFixed(3)) }))
}
