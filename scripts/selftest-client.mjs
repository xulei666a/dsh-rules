#!/usr/bin/env node
/**
 * dsh-rules client bundle 离线自检（无浏览器）：
 *   - 能被 __ModuleLoader__ 加载并返回 exports.apply / exports.inject
 *   - apply 用假 ctx 时注册出正确的侧栏页签类型与 pane 主体
 *   - title/description 必须是函数（宿主会调用；字符串会让右栏空白）
 * 用法: node scripts/selftest-client.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS ' + name) } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

let entry
const noop = () => {}
const fakeEl = () => ({ style: {}, appendChild: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop, click: noop })
const sandbox = {
  window: {
    __ModuleLoader__: { load(v) { entry = v } },
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    innerWidth: 1200,
    innerHeight: 800,
  },
  document: {
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    createElement: fakeEl,
    body: { appendChild: noop },
  },
  console: { warn() {}, log() {}, error() {} },
}
vm.runInContext(source, vm.createContext(sandbox), { timeout: 2000 })

test('bundle 注册到 __ModuleLoader__ 且 id 正确', () => {
  assert(entry, '没有调用 __ModuleLoader__.load')
  assert(entry.id === 'dsh-rules', 'id 应为 dsh-rules，实际 ' + entry.id)
  assert(typeof entry.factory === 'function', 'factory 必须是函数')
})

const React = {
  createElement: (type, props) => ({ type, props }),
  createContext: () => ({}),
}
const mod = entry.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

test('exports 形状：apply 函数 + inject includes slots', () => {
  assert(typeof mod.apply === 'function', '缺 exports.apply')
  assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 必须含 slots')
})

test('apply 注册页签类型 + pane 主体（契约字段正确）', () => {
  const state = { tab: null, pane: null, disposers: 0 }
  const ctx = {
    effect(fn) { const d = fn(); state.disposers++; return d },
    inject(names, cb) {
      assert(Array.isArray(names) && names.includes('sidebarRightTabs'), '应 inject sidebarRightTabs')
      cb({
        get(name) {
          if (name !== 'sidebarRightTabs') return undefined
          return {
            register(def) {
              state.tab = def
              return () => {}
            },
          }
        },
      })
    },
    slots: {
      inject(name, cb) {
        assert(name === 'sidebar.right.pane.tab', 'pane slot 名不对：' + name)
        return cb()
      },
      register(options, component) {
        state.pane = { options, component }
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert(state.tab, '没有注册页签类型')
  const t = state.tab
  assert(t.id === 'dsh-rules' && t.kind === 'dsh-rules', 'id/kind 必须是 dsh-rules')
  assert(t.priority === 'extension', 'priority 应为 extension')
  assert(typeof t.title === 'function', 'title 必须是函数（宿主会调用）')
  assert(typeof t.title() === 'string' && t.title().length > 0, 'title() 应返回字符串')
  assert(Array.isArray(t.guide) && t.guide.length >= 1, 'guide 至少一项')
  for (const g of t.guide) {
    assert(typeof g.id === 'string', 'guide.id 必须是 string')
    assert(typeof g.order === 'number', 'guide.order 必须是数字')
    assert(typeof g.title === 'function', 'guide.title 必须是函数')
    assert(g.description === undefined || typeof g.description === 'function', 'guide.description 必须是函数')
  }
  assert(state.pane, '没有注册 pane 主体')
  assert(state.pane.options.key === t.id, 'pane 的 key 必须等于页签类型 id')
  assert(typeof state.pane.options.inject === 'function', 'pane inject 必须是函数')
  assert(typeof state.pane.component === 'function', 'pane 组件必须是函数')
  const el = state.pane.component()
  assert(el && el.type === 'iframe', '面板组件应渲染 iframe')
  assert(String(el.props.src).includes('/dsh-rules/ui'), 'iframe 应指向 /dsh-rules/ui')
})

test('宿主缺失服务时不抛错（降级安全）', () => {
  const ctx = {
    effect(fn) { return fn() },
    inject() { throw new Error('no service') },
    slots: { inject() { throw new Error('no slots') }, register() {} },
  }
  mod.apply(ctx) // 内部 try/catch，不应抛
})

console.log(`\nclient selftest: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
