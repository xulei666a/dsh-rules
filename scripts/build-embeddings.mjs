#!/usr/bin/env node
/** 构建/刷新规则 embedding 缓存（B 档语义路由）。首次会从 hf-mirror 下载模型。 */
import { loadRules } from '../lib/store.js'
import { ensureRuleEmbeddings, embeddingInstalled, MODEL, CACHE_FILE } from '../lib/embedding.js'

if (!embeddingInstalled()) {
  console.error('未安装 embedding 依赖。运行: node scripts/setup-embed.mjs')
  process.exit(1)
}
const rules = loadRules()
console.log(`规则 ${rules.length} 条，模型 ${MODEL}（首次会下载，走 hf-mirror）…`)
const t0 = Date.now()
const r = await ensureRuleEmbeddings(rules, { log: (m) => console.log('  ' + m) })
console.log(`完成：本次新算 ${r.rebuilt} 条，缓存共 ${r.total} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('缓存：' + CACHE_FILE)
