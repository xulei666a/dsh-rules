/**
 * dsh-rules · 技能导入（把任意位置下载到的"技能"变成 DSH 可读）
 *
 * 场景：用户从别处下载了一个技能（目录 / zip），位置任意、结构不一定规范。
 * 做法：
 *   1. inspect：检查目录结构，找 SKILL.md；没有就根据内容生成一个最小可用的
 *   2. install：复制到 ~/.dsh/skills/<slug>/（DSH 唯一能自动读的技能目录），并做基本校验
 *   3. drafts：从 SKILL.md 提取候选准则（只产出草稿，由用户/agent 确认后再入库）
 *
 * 注意：安装是"复制"，源目录保持不动；已存在同名技能默认不覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_DIR = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const SKILLS_DIR = path.join(DSH_DIR, 'skills')

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill'
const readText = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { data: {}, body: md, hasFrontmatter: false }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    data[kv[1]] = v
  }
  return { data, body: md.slice(m[0].length), hasFrontmatter: true }
}

function listFiles(dir, depth = 0, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    out.push(path.relative(dir, p))
    if (e.isDirectory() && depth < 3) listFiles(p, depth + 1, out)
  }
  return out
}

/** 找技能根：传入可能是技能目录本身、也可能是包含一个技能子目录的父目录 */
export function resolveSkillRoot(input) {
  const abs = path.resolve(String(input || ''))
  if (!isDir(abs)) throw new Error('目录不存在：' + abs)
  if (isFile(path.join(abs, 'SKILL.md'))) return { root: abs, nested: false }
  // 父目录里恰好一个带 SKILL.md 的子目录 → 用它
  let dirs = []
  try { dirs = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch {}
  const withSkill = dirs.filter((d) => isFile(path.join(abs, d, 'SKILL.md')))
  if (withSkill.length === 1) return { root: path.join(abs, withSkill[0]), nested: true }
  if (withSkill.length > 1) return { root: abs, nested: false, multiple: withSkill }
  return { root: abs, nested: false }
}

/** 解压 zip（Windows 用 PowerShell，其它系统用 unzip） */
export function extractArchive(file) {
  const abs = path.resolve(file)
  if (!isFile(abs)) throw new Error('文件不存在：' + abs)
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-'))
  if (/\.zip$/i.test(abs)) {
    try { execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${abs.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { stdio: 'pipe' }) }
    catch (e) { try { execFileSync('unzip', ['-o', abs, '-d', dest], { stdio: 'pipe' }) } catch { throw new Error('解压失败（zip）：' + String(e?.message ?? e)) } }
  } else if (/\.tar\.gz$|\.tgz$/i.test(abs)) {
    execFileSync('tar', ['-xzf', abs, '-C', dest], { stdio: 'pipe' })
  } else throw new Error('只支持目录 / .zip / .tar.gz')
  return dest
}

/** 检查一个技能目录（不改动任何东西） */
export function inspectSkill(input) {
  const resolved = resolveSkillRoot(input)
  const root = resolved.root
  const files = listFiles(root)
  const skillFile = path.join(root, 'SKILL.md')
  const hasSkillMd = isFile(skillFile)
  const md = hasSkillMd ? readText(skillFile) : ''
  const fm = parseFrontmatter(md)
  const warnings = []
  if (!hasSkillMd) warnings.push('没有 SKILL.md：安装时会生成一个最小 SKILL.md（DSH 靠它识别技能）')
  else {
    if (!fm.hasFrontmatter) warnings.push('SKILL.md 没有 frontmatter：DSH 需要 name/description 才能稳定触发，安装时会补')
    if (!fm.data.description) warnings.push('frontmatter 缺 description：会自动补一句')
  }
  if (!files.length) warnings.push('目录是空的')
  return {
    ok: true,
    root,
    nested: resolved.nested,
    multiple: resolved.multiple || null,
    hasSkillMd,
    name: fm.data.name || path.basename(root),
    description: fm.data.description || '',
    files: files.slice(0, 60),
    fileCount: files.length,
    warnings,
  }
}

/** 生成/修正 SKILL.md（保证 DSH 能读） */
function ensureSkillMd(root, { name, description } = {}) {
  const skillFile = path.join(root, 'SKILL.md')
  const md = readText(skillFile)
  const fm = parseFrontmatter(md)
  const finalName = (fm.data.name || name || path.basename(root)).trim()
  let finalDesc = (fm.data.description || description || '').trim()
  if (!finalDesc) {
    // 从正文第一个非标题段落或前几行提炼
    const body = (fm.body || md).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !s.startsWith('---'))
    finalDesc = (body[0] || `使用 ${finalName} 技能完成相关任务`).slice(0, 160)
  }
  if (fm.hasFrontmatter && fm.data.name && fm.data.description) return { changed: false, name: finalName, description: finalDesc }
  const body = (fm.body || md).trim() || `# ${finalName}\n\n${finalDesc}\n`
  const head = `---\nname: ${finalName}\ndescription: ${finalDesc}\n---\n\n`
  fs.writeFileSync(skillFile, head + body + '\n', 'utf8')
  return { changed: true, name: finalName, description: finalDesc }
}

/** 安装到 ~/.dsh/skills/<slug>；返回安装结果 */
export function installSkill(input, { name = '', description = '', overwrite = false } = {}) {
  let src = String(input || '')
  let staged = null
  if (isFile(path.resolve(src))) { staged = extractArchive(src); src = staged }
  const info = inspectSkill(src)
  const targetName = slug(name || info.name || path.basename(info.root))
  const target = path.join(SKILLS_DIR, targetName)
  if (fs.existsSync(target) && !overwrite) throw new Error(`技能已存在：${target}（要覆盖请传 overwrite:true）`)
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  const tmpTarget = target + '.tmp-' + Date.now().toString(36)
  fs.cpSync(info.root, tmpTarget, { recursive: true })
  const fixed = ensureSkillMd(tmpTarget, { name: targetName, description })
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(tmpTarget, target)
  if (staged) { try { fs.rmSync(staged, { recursive: true, force: true }) } catch {} }
  return {
    installed: target,
    name: targetName,
    skillMdFixed: fixed.changed,
    description: fixed.description,
    source: info.root,
    files: info.fileCount,
    warnings: info.warnings,
  }
}

const CATEGORY_HINTS = [
  ['install', /安装|下载|npm|pip|setup|install|镜像/i],
  ['paths', /目录|路径|path|folder|directory/i],
  ['tools', /工具|命令|command|cli|脚本|script/i],
  ['style', /风格|排版|style|字体|配色|模板/i],
  ['safety', /安全|权限|确认|删除|备份|权限/i],
  ['workflow', /流程|步骤|先.*再|workflow|检查|验收/i],
  ['model', /模型|token|成本|预算|model/i],
  ['skill', /技能|插件|skill|plugin/i],
]

/** 从技能内容提取候选准则（只是草稿，不写库） */
export function draftRulesFromSkill(skillDir, { max = 10 } = {}) {
  const md = readText(path.join(skillDir, 'SKILL.md'))
  const body = parseFrontmatter(md).body
  const drafts = []
  const seen = new Set()
  const pushDraft = (title, value, category) => {
    const t = String(title || '').replace(/^#+\s*/, '').replace(/[：:]\s*$/, '').trim()
    const v = String(value || '').replace(/\s+/g, ' ').trim()
    if (!t || !v || v.length < 6 || drafts.length >= max) return
    const k = slug(t)
    if (seen.has(k)) return
    seen.add(k)
    drafts.push({
      key: `${category}.${k}`,
      title: t.slice(0, 40),
      value: v.slice(0, 240),
      category,
      status: 'pending',
      source: 'skill:' + path.basename(skillDir),
    })
  }
  const lines = body.split(/\r?\n/)
  let heading = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^#{2,4}\s+(.+)$/)
    if (h) { heading = h[1].trim(); continue }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (!bullet) continue
    const text = bullet[1].trim()
    // 硬参数/命令/路径类最有价值
    const hasCmd = /`[^`]+`/.test(text) || /(\b(npm|pnpm|pip|node|python|blender|git|ffmpeg)\b\s)/i.test(text)
    const hasNum = /\d+\s*(ms|s|秒|分钟|px|%|字|行|条)/i.test(text)
    if (!hasCmd && !hasNum) continue
    const cat = (CATEGORY_HINTS.find(([, re]) => re.test(text)) || ['workflow'])[0]
    pushDraft(heading || text.slice(0, 20), text, cat)
  }
  return drafts
}

/** 把用户一句话草稿变成结构化准则（本地启发式，供 agent/UI 预览后保存） */
export function draftRuleFromText(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('缺少描述')
  // 去掉引导语：「帮我记一条准则：」「新规则：」…
  let bodyText = raw
  const lead = raw.match(/^[^:：]{0,30}?(准则|规则|记住|要求)[^:：]{0,10}[:：]\s*([\s\S]+)$/)
  if (lead) bodyText = lead[2].trim()
  const first = bodyText.split(/[。；;\n]/)[0].trim()
  const cat = (CATEGORY_HINTS.find(([, re]) => re.test(bodyText)) || ['workflow'])[0]
  const quoted = bodyText.match(/[「“"']([^」”"']{4,})[」”"']/)
  const value = (quoted ? quoted[1] : bodyText).trim()
  const title = first.replace(/[「“"'].*?[」”"']/g, '').replace(/[。；;，,]\s*$/, '').slice(0, 40) || first.slice(0, 40)
  return {
    key: `${cat}.${slug(title)}`,
    title,
    value: value.slice(0, 400),
    category: cat,
    status: 'pending',
    source: 'draft',
  }
}
