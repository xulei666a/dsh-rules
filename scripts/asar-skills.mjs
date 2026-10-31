#!/usr/bin/env node
/**
 * 从 DSH 的 app.asar 里抽出内置技能的 SKILL.md（办公套件等内置技能是打包的，
 * 用户技能目录与插件目录都没有）。只抽 `skills/` 下以 SKILL.md 结尾的文件。
 *
 * 产出：~/.dsh/rules/harvest/asar/<slug>.md
 * 用法: node scripts/asar-skills.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.env.DSH_ASAR || 'D:\\DSH\\resources\\app.asar'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const OUT = path.join(HOME, '.dsh', 'rules', 'harvest', 'asar')

export function extractAsarSkills(asarPath = ASAR) {
  if (!fs.existsSync(asarPath)) return { error: 'app.asar 不存在：' + asarPath, files: [] }
  const fd = fs.openSync(asarPath, 'r')
  try {
    // asar 头部：4 个 uint32（pickle）+ JSON header，JSON 从第 16 字节开始
    const head = Buffer.alloc(4096)
    fs.readSync(fd, head, 0, 4096, 0)
    let start = head.indexOf(Buffer.from('{"files"'))
    if (start < 0) start = head.indexOf(Buffer.from('{'))
    if (start < 0) throw new Error('asar header 找不到 JSON 起始')
    // 按括号深度找到 JSON 结尾（header 可达数 MB）
    const chunk = 1 << 20
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    let pos = start
    const fileSize = fs.statSync(asarPath).size
    while (pos < fileSize && end < 0) {
      const size = Math.min(chunk, fileSize - pos)
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, pos)
      for (let i = 0; i < size; i++) {
        const c = buf[i]
        if (inStr) {
          if (esc) esc = false
          else if (c === 92) esc = true
          else if (c === 34) inStr = false
        } else if (c === 34) inStr = true
        else if (c === 123) depth++
        else if (c === 125) { depth--; if (depth === 0) { end = pos + i + 1; break } }
      }
      pos += size
    }
    if (end < 0) throw new Error('asar header JSON 未闭合')
    const jsonLen = end - start
    const headerBuf = Buffer.alloc(jsonLen)
    fs.readSync(fd, headerBuf, 0, jsonLen, start)
    const header = JSON.parse(headerBuf.toString('utf8'))
    const baseOffset = end
    const files = []
    const walk = (node, prefix) => {
      if (!node || typeof node !== 'object') return
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix ? prefix + '/' + name : name
        if (entry && entry.files) { walk(entry, p); continue }
        if (!/\/skills\/.*SKILL\.md$/i.test(p)) continue
        if (entry.offset === undefined) continue
        files.push({ path: p, offset: parseInt(entry.offset, 10), size: entry.size })
      }
    }
    walk(header, '')
    fs.mkdirSync(OUT, { recursive: true })
    const saved = []
    for (const f of files) {
      const buf = Buffer.alloc(f.size)
      fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset)
      const slug = f.path.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-120)
      const out = path.join(OUT, slug)
      fs.writeFileSync(out, buf.toString('utf8'), 'utf8')
      saved.push({ path: f.path, file: out, bytes: f.size })
    }
    return { asar: asarPath, baseOffset, files: saved }
  } finally {
    fs.closeSync(fd)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const r = extractAsarSkills()
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    if (r.error) { console.log(r.error); process.exit(1) }
    console.log(`从 app.asar 抽出内置技能 SKILL.md：${r.files.length} 个 → ${OUT}`)
    for (const f of r.files) console.log('  - ' + f.path + '  (' + f.bytes + ' bytes)')
  }
}
