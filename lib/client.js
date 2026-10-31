/**
 * dsh-rules · client 侧（右栏原生面板）
 *
 * 面板内容统一复用已有的管理页 `/dsh-rules/ui`（自包含 HTML），
 * 这样原生面板与浏览器管理页永远同一份界面、同一套 API。
 *
 * 契约（照抄本机 better-sidebar / blender 客户端已验证写法）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *   exports.apply(ctx) + exports.inject = ['slots']
 *
 * 页签类型：ctx.inject(['sidebarRightTabs']) → tabs.register({
 *   id, kind, priority:'extension', keepMounted:true,
 *   title: () => string,                      // 宿主会调用，必须是函数
 *   guide: [{ id, order, title: () => string, description: () => string }]
 * })
 * 页签主体：ctx.slots.inject('sidebar.right.pane.tab') +
 *   ctx.slots.register({ name, key: <type id>, inject: (sessionId) => ({ sessionId }) }, Component)
 */
window.__ModuleLoader__.load({
  id: 'dsh-rules',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var KIND = 'dsh-rules'
    var TAB_ID = 'dsh-rules'

    /**
     * 可拖动的小窗口：显示完整结构图（不覆盖整个 DSH，不影响主窗口按钮）。
     * 面板 iframe 里点「查看完整结构」时通过 postMessage 请求打开。
     */
    var overlayId = 'dsh-rules-topo-overlay'
    var topoCleanup = null
    function closeTopoOverlay() {
      var el = document.getElementById(overlayId)
      if (el && el.parentNode) el.parentNode.removeChild(el)
      if (topoCleanup) { try { topoCleanup() } catch (e) {} topoCleanup = null }
    }
    function openTopoOverlay(key) {
      closeTopoOverlay()
      var vw = window.innerWidth, vh = window.innerHeight
      var W = Math.min(1040, Math.max(560, Math.round(vw * 0.72)))
      var H = Math.min(760, Math.max(380, Math.round(vh * 0.72)))
      var win = document.createElement('div')
      win.id = overlayId
      win.style.cssText = [
        'position:fixed',
        'left:' + Math.max(8, Math.round((vw - W) / 2)) + 'px',
        'top:' + Math.max(8, Math.round((vh - H) / 2)) + 'px',
        'width:' + W + 'px',
        'height:' + H + 'px',
        'min-width:420px', 'min-height:200px',
        'z-index:2147483000', 'background:#fff',
        'border:1px solid #e5e7eb', 'border-radius:12px',
        'box-shadow:0 18px 50px rgba(0,0,0,.24)',
        'display:flex', 'flex-direction:column', 'overflow:hidden',
        'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
      ].join(';')

      // 标题栏（拖动区域 + 自己的最小化/关闭）
      var bar = document.createElement('div')
      bar.style.cssText = [
        'display:flex', 'align-items:center', 'gap:6px',
        'padding:6px 8px', 'background:#f9fafb',
        'border-bottom:1px solid #e5e7eb', 'cursor:move', 'user-select:none',
        'flex:0 0 auto',
      ].join(';')
      var title = document.createElement('span')
      title.textContent = '流程结构'
      title.style.cssText = 'font-weight:600;color:#111827;margin-right:4px'
      var hint = document.createElement('span')
      hint.textContent = '拖动标题栏移动 · 右下角缩放'
      hint.style.cssText = 'color:#9ca3af;font-size:11px'
      bar.appendChild(title)
      bar.appendChild(hint)
      var spacer = document.createElement('span')
      spacer.style.cssText = 'flex:1'
      bar.appendChild(spacer)

      function mkBtn(label) {
        var b = document.createElement('button')
        b.textContent = label
        b.style.cssText = [
          'border:1px solid #e5e7eb', 'background:#fff', 'color:#374151',
          'border-radius:6px', 'padding:2px 8px', 'cursor:pointer',
          'font:11.5px/1.6 system-ui,sans-serif',
        ].join(';')
        return b
      }
      var minBtn = mkBtn('最小化')
      var closeBtn = mkBtn('关闭')
      closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closeTopoOverlay() })
      bar.appendChild(minBtn)
      bar.appendChild(closeBtn)
      win.appendChild(bar)

      var body = document.createElement('div')
      body.style.cssText = 'flex:1;min-height:0;display:flex;overflow:hidden;background:#fff'
      var frame = document.createElement('iframe')
      frame.src = '/dsh-rules/ui?topo=' + encodeURIComponent(String(key || ''))
      frame.title = '流程结构'
      frame.style.cssText = 'flex:1;width:100%;height:100%;border:0;display:block'
      body.appendChild(frame)
      win.appendChild(body)

      // 右下角缩放把手
      var grip = document.createElement('div')
      grip.style.cssText = [
        'position:absolute', 'right:0', 'bottom:0', 'width:16px', 'height:16px',
        'cursor:nwse-resize',
        'background:linear-gradient(135deg,transparent 50%,#d1d5db 50%)',
        'border-bottom-right-radius:12px',
      ].join(';')
      win.appendChild(grip)
      document.body.appendChild(win)

      // 拖动
      var drag = null
      function onBarDown(e) {
        if (e.target === closeBtn || e.target === minBtn) return
        drag = { x: e.clientX, y: e.clientY, left: parseFloat(win.style.left), top: parseFloat(win.style.top) }
        document.addEventListener('mousemove', onDragMove)
        document.addEventListener('mouseup', onDragUp)
        e.preventDefault()
      }
      function onDragMove(e) {
        if (!drag) return
        var nl = drag.left + (e.clientX - drag.x)
        var nt = drag.top + (e.clientY - drag.y)
        var maxL = window.innerWidth - 80
        var maxT = window.innerHeight - 40
        win.style.left = Math.max(0, Math.min(maxL, nl)) + 'px'
        win.style.top = Math.max(0, Math.min(maxT, nt)) + 'px'
      }
      function onDragUp() {
        drag = null
        document.removeEventListener('mousemove', onDragMove)
        document.removeEventListener('mouseup', onDragUp)
      }
      bar.addEventListener('mousedown', onBarDown)

      // 缩放
      var resize = null
      function onGripDown(e) {
        resize = { x: e.clientX, y: e.clientY, w: win.offsetWidth, h: win.offsetHeight }
        document.addEventListener('mousemove', onResizeMove)
        document.addEventListener('mouseup', onResizeUp)
        e.preventDefault()
        e.stopPropagation()
      }
      function onResizeMove(e) {
        if (!resize) return
        var w = Math.max(420, resize.w + (e.clientX - resize.x))
        var h = Math.max(200, resize.h + (e.clientY - resize.y))
        win.style.width = Math.min(w, window.innerWidth - 20) + 'px'
        win.style.height = Math.min(h, window.innerHeight - 20) + 'px'
      }
      function onResizeUp() {
        resize = null
        document.removeEventListener('mousemove', onResizeMove)
        document.removeEventListener('mouseup', onResizeUp)
      }
      grip.addEventListener('mousedown', onGripDown)

      // 最小化 / 还原
      var savedH = H
      var minimized = false
      minBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        if (!minimized) {
          savedH = win.offsetHeight
          win.style.height = '36px'
          body.style.display = 'none'
          grip.style.display = 'none'
          minBtn.textContent = '还原'
          minimized = true
        } else {
          win.style.height = savedH + 'px'
          body.style.display = 'flex'
          grip.style.display = ''
          minBtn.textContent = '最小化'
          minimized = false
        }
      })
      // 双击标题栏 = 最小化切换
      bar.addEventListener('dblclick', function () { minBtn.click() })

      function onKey(e) { if (e.key === 'Escape') closeTopoOverlay() }
      document.addEventListener('keydown', onKey)
      topoCleanup = function () {
        document.removeEventListener('keydown', onKey)
        document.removeEventListener('mousemove', onDragMove)
        document.removeEventListener('mouseup', onDragUp)
        document.removeEventListener('mousemove', onResizeMove)
        document.removeEventListener('mouseup', onResizeUp)
      }
    }

    window.__dshRulesTopoHost = true
    window.addEventListener('message', function (event) {
      var data = event && event.data
      if (!data || data.type !== 'dsh-rules:open-topo' || typeof data.key !== 'string') return
      try { openTopoOverlay(data.key) } catch (error) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-rules] 全屏拓扑打开失败：', error)
      }
    })

    function RulesPanel(props) {
      var sid = props && props.sessionId ? String(props.sessionId) : ''
      var src = '/dsh-rules/ui' + (sid ? '?session=' + encodeURIComponent(sid) : '')
      return React.createElement('iframe', {
        src: src,
        title: '统一准则',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '320px',
          border: '0',
          display: 'block',
          background: 'transparent',
        },
      })
    }

    function apply(ctx) {
      // 1) 页签类型：让「统一准则」出现在右栏 Guide 页，点一下就打开
      try {
        ctx.inject(['sidebarRightTabs'], function (injected) {
          var tabs = injected && typeof injected.get === 'function' ? injected.get('sidebarRightTabs') : undefined
          if (!tabs || typeof tabs.register !== 'function') return
          var register = function () {
            return tabs.register({
              id: TAB_ID,
              kind: KIND,
              priority: 'extension',
              keepMounted: true,
              title: function () { return '统一准则' },
              guide: [
                {
                  id: TAB_ID,
                  order: 60,
                  title: function () { return '统一准则' },
                  description: function () { return '查看与修改 agent 的准则库' },
                },
              ],
            })
          }
          if (typeof ctx.effect === 'function') ctx.effect(register)
          else register()
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-rules] 页签注册失败：', error)
      }

      // 2) 页签主体：key 必须等于上面 definition 的 id
      try {
        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              inject: function (sessionId) { return { sessionId: sessionId } },
            },
            RulesPanel,
          )
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-rules] 面板注册失败：', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
