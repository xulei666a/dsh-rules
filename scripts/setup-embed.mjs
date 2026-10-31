#!/usr/bin/env node
/** 安装 B 档本地 embedding 依赖（@xenova/transformers + sharp 预编译，走 npmmirror） */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EMBED_DIR, embeddingInstalled } from '../lib/embedding.js'

if (embeddingInstalled()) { console.log('已安装：' + EMBED_DIR); process.exit(0) }
fs.mkdirSync(EMBED_DIR, { recursive: true })
const pkg = {
  name: 'dsh-rules-embed',
  private: true,
  type: 'module',
  dependencies: { '@xenova/transformers': '^2.17.2', sharp: '0.33.5' },
  overrides: { sharp: '0.33.5' },
}
fs.writeFileSync(path.join(EMBED_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('安装依赖到 ' + EMBED_DIR + ' …')
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com'], { cwd: EMBED_DIR, stdio: 'inherit' })
console.log('完成。现在运行: node scripts/build-embeddings.mjs')
