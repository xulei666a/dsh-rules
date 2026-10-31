/**
 * dsh-rules · 面板内助手会话
 *
 * 面板（统一准则栏）里的对话框 → 通过宿主的 ctx.sessionController 投递到一条**真实 DSH 会话**，
 * 助手有 dsh-rules 的全部工具（含 skill_import / rules_draft），所以「导入技能」「帮我写准则」
 * 这类事是真能干，而不只是聊天。
 *
 * 回复读取：DSH 把会话日志存成 ~/.dsh/sessions 下的 session.v4.jsonl.zstd，
 * 格式是「多段 zstd frame 拼接，每段解压后是 JSONL」。这里按 magic(28 B5 2F FD) 切帧解压，
 * 提取 user/message 与 assistant/message 的 text 段。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_DIR = process.env.DSH_HOME || path.join(HOME, '.dsh')
const SESSIONS_DIR = path.join(DSH_DIR, 'sessions')
const RULES_DIR = path.join(DSH_DIR, 'rules')
export const ASSISTANT_STATE = path.join(RULES_DIR, 'assistant.json')
/** 固定复用一条会话（正常对话不再新建侧栏项目；只有「新会话」才换 id） */
export const DEFAULT_ASSISTANT_SESSION = 'rules-assistant-main'
export const ASSISTANT_GUIDE = path.join(RULES_DIR, 'ASSISTANT.md')
/** 助手会话的工作区目录：DSH 会按目录名生成侧栏分组，所以目录名就是分组名 */
export const ASSISTANT_DIR = path.join(RULES_DIR, '准则会话分组')
export const ASSISTANT_TITLE = '准则助手'
export const ASSISTANT_GROUP_TITLE = '准则会话分组'
export const ASSISTANT_CONTEXT = path.join(RULES_DIR, 'assistant-context.json')

const GUIDE_TEXT = `# 统一准则助手 · 职责

你是 dsh-rules 插件的「统一准则助手」，用户在统一准则面板的对话框里发来消息。
**用户消息就是原话，没有前置说明**——不要期待、也不要复述任何前缀。

## 职责

1. 批量操作（最常见）：用户说「这些规则、那批规则」时，优先用 rules_bulk（可按 keys / keyPrefix / category / appliesTo / query 选中一批，一次改适用面、状态，或在本对话翻生效）。先 dryRun=true 预览匹配条数，简要报数后再 dryRun=false 落库；不要一条条调 rules_set。
2. 用户说「下载/放置了一个技能、资料在某路径」→ 用 skill_import 检查并安装到 DSH 技能目录，必要时从技能里提取候选准则（只产草稿，别自动入库）。
3. 用户想新建/修改准则但不会写 → 用 rules_draft 把一句话变成结构化草稿，再用 rules_set 保存（拿不准就 pending）。
4. 涉及技能更新/来源问题时，用 rules_sources（op=plan/record）。
5. 面板「读取规则」会发来一条【读取规则任务】：按任务文本调用 rules_collect → rules_mark_read → rules_issues，然后按任务要求简短汇报。
6. 个性化分类：先用 rules_groups 看现有方案和节点（基准：产出交付 / 记忆与底线 / 工作方式 / 工具与环境 / 待复核），再按用户说的新建或改名节点，最后用 rules_bulk op=move（targetTitle 指向节点）批量移入——先 dryRun=true 预览条数。不要一次推倒基准分类；没说清楚时先问一句「想怎么分」。
7. 校准待复核：先 rules_query（includeInactive=true, status=pending）读，逐条判断「生效 / 删除 / 保留」，只回摘要和例子；用户回「确认」后再用 rules_bulk op=set_status（先 dryRun）和 rules_remove。一次不要超过 60 条，不要未经确认就删除。
8. 问题台账：用户问「有哪些问题 / 检查一下准则库」时调用 rules_issues；按「归属」分组回报（待复核 / 冲突 / 同标题多条 / 重复内容 / 来源失效 / 抑制清单 / 字段异常 / 适用面），每组一句处理建议，最多列 8 组。不要自动改库；用户说「处理某一类」再 dryRun 预览后执行。

## 回答风格

- 短（≤120 字），先给结论或数量，不罗列过程；需要确认时用一句话问。
- 规则库写入一律用 rules_* 工具，不要手改文件；批量改动前先预览。

## 本对话生效

你跑在助手自己的会话里，用户此刻在另一个会话操作面板。涉及「本对话生效 / 仅当前对话」的 rules_bulk op=pin|unpin 或 rules_session 操作时，必须显式传用户面板所在会话的 tag（见 \`~/.dsh/rules/assistant-context.json\` 的 \`targetSession\`，若为空则先问用户），否则会改到助手会话，用户看不到效果。
`

/** 写入/更新职责文件（每次发送前调用，内容变化才写盘） */
export function ensureAssistantGuide() {
  try {
    fs.mkdirSync(RULES_DIR, { recursive: true })
    const cur = fs.existsSync(ASSISTANT_GUIDE) ? fs.readFileSync(ASSISTANT_GUIDE, 'utf8') : ''
    if (cur !== GUIDE_TEXT) {
      fs.writeFileSync(ASSISTANT_GUIDE, GUIDE_TEXT, 'utf8')
      // 助手会话的工作区：DSH 会自动读取该目录的 AGENTS.md 作为工作区指令，
      // 所以职责不再塞进每条用户消息。
      fs.mkdirSync(ASSISTANT_DIR, { recursive: true })
      fs.writeFileSync(path.join(ASSISTANT_DIR, 'AGENTS.md'), GUIDE_TEXT, 'utf8')
    }
  } catch {}
  return GUIDE_TEXT
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dflt } }
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8') }

export function getAssistantState() {
  const st = readJson(ASSISTANT_STATE, null)
  return st && st.sessionId ? st : null
}
export function saveAssistantState(st) { writeJson(ASSISTANT_STATE, st) }

/** 找到会话日志文件（路径里带 sessionId 的 session.v4.jsonl.zstd） */
export function findSessionFile(sessionId) {
  const stack = [SESSIONS_DIR]
  let guard = 0
  while (stack.length && guard < 5000) {
    guard += 1
    const d = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === 'session.v4.jsonl.zstd' && p.includes(sessionId)) return p
    }
  }
  return null
}

/* ---------------- 会话日志解码（帧切分 + 增量） ---------------- */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const _cache = new Map() // file -> { size, mtime, events }

function decodeTranscript(file) {
  const b = fs.readFileSync(file)
  const starts = []
  let i = 0
  while ((i = b.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
  const chunks = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : b.length
    try { chunks.push(zlib.zstdDecompressSync(b.subarray(s, e))) } catch { /* 跳过坏帧 */ }
  }
  const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)
  const events = []
  for (const line of lines) { try { events.push(JSON.parse(line)) } catch {} }
  return events
}

export function readSessionEvents(file) {
  const st = fs.statSync(file)
  const hit = _cache.get(file)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.events
  const events = decodeTranscript(file)
  _cache.set(file, { size: st.size, mtime: st.mtimeMs, events })
  return events
}

const textOf = (content) => Array.isArray(content) ? content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim() : ''

/** 提取面板可显示的对话（跳过时间上下文、系统注入等噪音） */
export function extractChat(events, { limit = 60 } = {}) {
  const msgs = []
  let lastTurn = 0
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const d = ev.data || {}
      const kind = d.source?.kind
      if (kind && !['user', 'client'].includes(kind)) continue
      const text = textOf(d.content)
      if (!text) continue
      lastTurn = Math.max(lastTurn, ev.seq || 0)
      msgs.push({ role: 'user', text, at: ev.time || 0, id: d.id || String(ev.seq) })
    } else if (ev.type === 'assistant/message') {
      const d = ev.data || {}
      const text = textOf(d.message?.content || d.content)
      if (!text) continue
      msgs.push({ role: 'assistant', text, at: ev.time || 0, id: 'a' + (ev.seq || 0) })
    }
  }
  return { messages: msgs.slice(-limit), count: msgs.length }
}

/** 面板对话：返回 { sessionId, messages, exists } */
export function getAssistantChat({ limit = 60 } = {}) {
  const st = getAssistantState()
  if (!st) return { sessionId: null, messages: [], exists: false }
  const file = findSessionFile(st.sessionId)
  if (!file) return { sessionId: st.sessionId, messages: [], exists: true, fileFound: false }
  const ev = readSessionEvents(file)
  return { sessionId: st.sessionId, messages: extractChat(ev, { limit }).messages, fileFound: true, updatedAt: fs.statSync(file).mtimeMs }
}

/* ---------------- 投递（需要宿主 sessionController） ---------------- */
let _busy = false
export const assistantBusy = () => _busy

export function buildAssistantPrompt(userText, { targetSession = '' } = {}) {
  const lines = [
    '【统一准则面板 · 助手请求】',
    '你是 dsh-rules 插件的「统一准则助手」，用户在统一准则面板的对话框里发来这条消息。',
    '你的职责：',
    '1) 批量操作（最常见）：用户说「这些规则、那批规则」时，优先用 rules_bulk 工具（可按 keys / keyPrefix / category / appliesTo / query 选中一批，一次改适用面、状态，或在本对话翻生效）。先 dryRun=true 预览匹配条数，简要报数后再 dryRun=false 落库；不要一条条调 rules_set。',
    '2) 用户说「下载/放置了一个技能、资料在某路径」→ 用 skill_import 工具检查并安装到 DSH 技能目录，必要时从技能里提取候选准则（只产草稿，别自动入库）。',
    '3) 用户想「新建/修改准则」但不会写 → 用 rules_draft 把一句话变成结构化草稿，再用 rules_set 保存（拿不准就 pending）。',
    '4) 涉及技能更新/来源问题时，用 rules_sources 工具（op=plan/record）。',
    '5) 用户在面板按「读取规则」时，会由面板自动发来「读取规则任务」：按提示调用 rules_collect 扫描 AGENTS.md / EXPERIENCE.md / 项目 AGENTS.md / 已装技能 SKILL.md / style-packs，把尚未收录的准则记录进统一准则库（重复的自动跳过），再调 rules_mark_read，最后只回一句「读取完成：新收录 X 条，当前共 Y 条」。',
    '6) 个性化分类：用户想按自己的习惯重新分类时，先用 rules_groups 看现有方案和节点（基准是 产出交付 / 记忆与底线 / 工作方式 / 工具与环境 / 待复核），再按用户说的新建或改名节点，最后用 rules_bulk op=move（targetTitle 指向节点）批量移入——先 dryRun=true 预览条数。不要一次推倒基准分类；用户没说清楚时先问一句「想怎么分」。',
    '7) 校准待复核：用户在对话里说「帮我校准待复核」时执行。pending 是机器从 AGENTS/经验库/技能提取、尚未确认的规则。先 rules_query（includeInactive=true, status=pending）读，逐条判断「生效 / 删除 / 保留」，只回摘要和例子；用户回「确认」后再用 rules_bulk op=set_status（先 dryRun）和 rules_remove 执行。不要一次处理超过 60 条，也不要未经确认就删除。',
    '8) 问题台账：用户问「有哪些问题 / 检查一下准则库」时，调用 rules_issues；按「归属」分组回报（待复核 / 冲突 / 同标题多条 / 重复内容 / 来源失效 / 抑制清单 / 字段异常 / 适用面），每组给一句处理建议，最多列 8 组。不要自动改库；用户说「处理某一类」再 dryRun 预览后执行。',
    '回答要短（≤120 字），先给结论或数量，不要罗列过程；需要用户确认的再用一句话问。',
    '注意：规则库写入要用 rules_* 工具，不要手改文件；批量改动前先预览。',
  ]
  if (targetSession) {
    lines.push(
      '重要：你是跑在助手自己的会话里的，用户此刻在另一个会话操作面板。',
      '用户当前会话 tag = ' + targetSession,
      '凡是涉及「本对话生效 / 仅当前对话」的 rules_bulk op=pin|unpin 或 rules_session 操作，必须显式传 session="' + targetSession + '"，否则会改到你自己这个助手会话，用户看不到效果。',
    )
  }
  lines.push('', '用户说：' + String(userText || '').trim())
  return lines.join('\n')
}

/**
 * 确保助手工作区在 DSH 里是一个真实分组（侧栏「准则会话分组」）。
 * 走宿主 workspaceController：workspace/create + workspace/rename。全部 best-effort。
 */
export async function ensureAssistantWorkspace(wc, { oldSessionId = '' } = {}) {
  try { fs.mkdirSync(ASSISTANT_DIR, { recursive: true }) } catch {}
  if (!wc) return { ok: false, reason: 'no workspaceController' }
  try {
    let created = await wc.create({ path: ASSISTANT_DIR })
    const ws = created?.workspace || created?.value?.workspace || created
    const workspaceId = ws?.workspaceId || ws?.id
    if (workspaceId) {
      try { await wc.rename(workspaceId, ASSISTANT_GROUP_TITLE) } catch { /* 标题已对就不改 */ }
    }
    // 旧的无分组助手会话从分组视图里归档掉，避免“未分组”里再出现助手
    if (oldSessionId) {
      try { await wc.archiveSession({ sessionId: oldSessionId }) } catch {}
    }
    return { ok: true, workspaceId: workspaceId || null }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}

/**
 * 发一条消息给助手会话（不存在则创建）。
 * @param {object} controller 宿主 ctx.sessionController（提供 create / prompt）
 */
export async function sendToAssistant(controller, text, { cwd = process.cwd(), sessionId = '', targetSession = '', sessions = null, workspaceController = null } = {}) {
  if (!controller || typeof controller.prompt !== 'function') throw new Error('宿主没有 sessionController，无法投递（需要重启 DSH 让插件拿到 ctx.sessionController）')
  const content = String(text || '').trim()
  if (!content) throw new Error('消息为空')
  if (_busy) throw new Error('助手正在处理上一条消息，请稍等')
  ensureAssistantGuide()
  if (targetSession) {
    try { writeJson(ASSISTANT_CONTEXT, { targetSession, updatedAt: new Date().toISOString() }) } catch {}
  }
  let st = getAssistantState()
  // 让「准则会话分组」成为 DSH 里真实存在的分组（不是“未分组”）
  const ws = await ensureAssistantWorkspace(workspaceController)
  const workspaceId = ws?.workspaceId || ''
  // 固定复用一条会话；只有工作区/分组变化、未确认入组、或「新会话」才换 id
  let sid = sessionId || ''
  if (!sid) {
    const reusable = st?.sessionId && st.cwd === ASSISTANT_DIR && st.grouped === true && (!workspaceId || st.workspaceId === workspaceId)
    sid = reusable ? st.sessionId : DEFAULT_ASSISTANT_SESSION + '-' + Date.now().toString(36)
  }
  const oldSid = !sessionId && st?.sessionId && st.sessionId !== sid ? st.sessionId : ''
  if (oldSid && workspaceController) { try { await workspaceController.archiveSession({ sessionId: oldSid }) } catch {} }
  let created = false
  let createdInWorkspace = false
  let createErr = null
  const joinWorkspace = async (id) => {
    if (!workspaceController || !workspaceId) return false
    try { await workspaceController.insertSessionBefore({ workspaceId, sessionId: id }); return true } catch { return false }
  }
  if (!sessionId) {
    // 正确姿势：只传 workspaceId（与 cwd 互斥）；会话的 cwd 由工作区路径决定。
    if (workspaceId) {
      try { await controller.create({ sessionId: sid, workspaceId }); created = true; createdInWorkspace = true }
      catch (e) { createErr = e }
    }
    if (!created) {
      try { await controller.create({ sessionId: sid, cwd: ASSISTANT_DIR }); created = true }
      catch (e) { createErr = e }
    }
    if (created) {
      // 会话标题固定成「准则助手」，侧栏一眼能认出来（放大按钮也按这个标题找）
      try { await controller.rename({ sessionId: sid, title: ASSISTANT_TITLE }) } catch {}
      // 兜底：即使用 cwd 建出来的，也尝试挂进分组
      if (!createdInWorkspace) createdInWorkspace = await joinWorkspace(sid)
    } else {
      await joinWorkspace(sid)
    }
  }
  if (!st || st.sessionId !== sid || st.cwd !== ASSISTANT_DIR || (workspaceId && st.workspaceId !== workspaceId)) {
    st = { sessionId: sid, cwd: ASSISTANT_DIR, workspaceId, grouped: createdInWorkspace, createdAt: new Date().toISOString() }
    saveAssistantState(st)
  } else if (st.grouped !== createdInWorkspace) {
    st.grouped = createdInWorkspace
    saveAssistantState(st)
  }
  _busy = true
  const promptOnce = async () => {
    // 宿主签名是 prompt(request, signal)：signal 必须存在（内部会 signal.throwIfAborted()）
    const ac = new AbortController()
    await controller.prompt({
      requestId: crypto.randomUUID(),     // 宿主要求：客户端铸的请求身份
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: content }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, ac.signal)
  }
  try {
    try {
      await promptOnce()
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (/subagent routing|agent-busy/i.test(msg)) {
        // 旧版本可能留下 origin='subagent' 的会话（宿主拒绝直接 prompt）→ 换一条普通会话重试
        sid = DEFAULT_ASSISTANT_SESSION + '-' + Date.now().toString(36)
        try { await controller.create({ sessionId: sid, cwd: ASSISTANT_DIR }); await joinWorkspace(sid) } catch {}
        saveAssistantState({ sessionId: sid, cwd: ASSISTANT_DIR, workspaceId, createdAt: new Date().toISOString() })
        await promptOnce()
      } else if (/not found/i.test(msg)) {
        // 状态里的会话不存在（旧版本残留）→ 用它自己的 id 建出来再投递
        try {
          await controller.create({ sessionId: sid, cwd: ASSISTANT_DIR })
          await joinWorkspace(sid)
          try { await controller.rename({ sessionId: sid, title: ASSISTANT_TITLE }) } catch {}
          saveAssistantState({ sessionId: sid, cwd: ASSISTANT_DIR, workspaceId, createdAt: new Date().toISOString() })
          await promptOnce()
        } catch (e2) { throw new Error('助手会话创建/投递失败：' + String(e2?.message ?? e2)) }
      } else if (createErr) {
        throw new Error('创建助手会话失败：' + String(createErr?.message ?? createErr))
      } else throw e
    }
  } finally { _busy = false }
  return { sessionId: sid, created, workspace: ws }
}

/** 重置助手会话（下次会新建一条） */
export function resetAssistant() {
  const sid = DEFAULT_ASSISTANT_SESSION + '-' + Date.now().toString(36)
  saveAssistantState({ sessionId: sid, cwd: ASSISTANT_DIR, createdAt: new Date().toISOString() })
  return true
}
