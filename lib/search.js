/**
 * dsh-rules · 模糊搜索（零依赖，浏览器与管理页共用）
 *
 * 支持：
 *   1. 完全包含（不分大小写）
 *   2. 英文字拼写容错（编辑距离：词长 ≤3 不容错、4–5 容 1、≥6 容 2）——blander → blender
 *   3. 字符顺序匹配（子序列，中英文都适用）——"建模m" → "blender 建模/..."
 *   4. 多词查询：每个词都命中才算命中
 */

export function editDistance(a, b, cap = 3) {
  a = String(a); b = String(b)
  if (a === b) return 0
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > cap) return cap + 1
  // Damerau-Levenshtein（含相邻字符互换，mdoel → model 只算 1 步）
  const d = []
  for (let i = 0; i <= la; i++) { d[i] = new Array(lb + 1); d[i][0] = i }
  for (let j = 0; j <= lb; j++) d[0][j] = j
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1)
      }
      d[i][j] = v > cap ? cap + 1 : v
    }
  }
  return d[la][lb]
}

export function isSubsequence(needle, haystack) {
  if (!needle) return true
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

function tokenHit(token, text) {
  if (!token) return true
  if (text.includes(token)) return true
  // 字符顺序匹配：太短的词容易误命中，要求 ≥3 个字符
  if (token.length >= 3 && isSubsequence(token, text)) return true
  // 英文拼写容错：按文本里的"词"逐个比编辑距离
  if (/[a-z]/.test(token)) {
    const maxD = token.length <= 3 ? 0 : token.length <= 5 ? 1 : 2
    if (maxD > 0) {
      const words = text.match(/[a-z0-9\u4e00-\u9fa5]+/g) || []
      for (const w of words) {
        if (Math.abs(w.length - token.length) > maxD) continue
        if (editDistance(token, w, maxD) <= maxD) return true
      }
    }
  }
  return false
}

/** 模糊命中：text 是否"大致"包含 query */
export function fuzzyHit(query, text) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const t = String(text || '').toLowerCase()
  if (t.includes(q)) return true
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return tokens.every((tok) => tokenHit(tok, t))
  return tokenHit(q, t)
}

/** 打分（用于排序）：完全包含 100 起，字符顺序 60，拼写容错按距离 40–20 */
export function fuzzyScore(query, text) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return 0
  const t = String(text || '').toLowerCase()
  if (t.includes(q)) return 100 + Math.min(q.length, 20)
  if (q.length >= 3 && isSubsequence(q, t)) return 60
  if (/[a-z]/.test(q)) {
    const maxD = q.length <= 3 ? 0 : q.length <= 5 ? 1 : 2
    if (maxD > 0) {
      const words = t.match(/[a-z0-9\u4e00-\u9fa5]+/g) || []
      let best = maxD + 1
      for (const w of words) {
        if (Math.abs(w.length - q.length) > maxD) continue
        const d = editDistance(q, w, maxD)
        if (d < best) best = d
      }
      if (best <= maxD) return 40 - best * 10
    }
  }
  return 0
}
