/**
 * dsh-dragon-control —— 客户端半边：输入框右侧工具条上的「龙爪权限模式」选择器。
 *
 * 两个模式与 DSH 自己的「完全权限」下拉是两回事，所以单独占一格：
 *   owner  用户确认 —— 敏感动作每次问一次
 *   auto   龙爪自己拍板 —— 不再询问
 *
 * 状态不复制、不缓存：打开时 GET /dragon-control/mode，点击时 POST 同一个地址，
 * 由宿主把值写进 permissions.json，和 scripts/mode.mjs 是同一个出处。
 *
 * 宿主没挂路由（旧版本）或未登录时返回非 200 —— 直接不渲染，不占地方。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dragon-control',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const MODE_URL = '/dragon-control/mode'
    const STYLE_ID = 'dsh-dragon-mode-style'
    const OPTIONS = [
      { value: 'owner', label: '手动', title: '用户决定：每个敏感动作都先问一次' },
      { value: 'auto', label: '自动', title: '龙爪自己决定：不再询问，显式拒绝项仍然生效' },
    ]

    const CSS = [
      '.dsh-dragon-mode{display:inline-flex;align-items:center;gap:2px;height:28px;padding:2px;',
      'border-radius:var(--dsw-radius-sm);background:transparent}',
      '.dsh-dragon-mode-title{font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);',
      'padding:0 4px 0 2px;white-space:nowrap;user-select:none}',
      '.dsh-dragon-mode-seg{border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:13px;font-weight:500;line-height:20px;height:24px;padding:0 8px;',
      'border-radius:calc(var(--dsw-radius-sm) - 2px);cursor:pointer;white-space:nowrap;',
      'transition:background-color .12s ease,color .12s ease}',
      '.dsh-dragon-mode-seg:hover:not(:disabled):not([data-active="true"]){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-dragon-mode-seg:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
      '.dsh-dragon-mode-seg[data-active="true"]{color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-button-ghost-active-fill);',
      'box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}',
      '.dsh-dragon-mode-seg[data-warn="true"][data-active="true"]{',
      'color:var(--dsw-alias-warning-text,#b25e00)}',
      '.dsh-dragon-mode[data-busy="true"]{opacity:.6}',
      '.dsh-dragon-mode[data-busy="true"] .dsh-dragon-mode-seg{cursor:default}',
    ].join('')

    function ensureStyle() {
      let tag = document.getElementById(STYLE_ID)
      if (tag) return
      tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.setAttribute('data-plugin', 'dsh-dragon-control')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function requestMode(init) {
      const options = init || {}
      return fetch(MODE_URL, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
        headers: { accept: 'application/json', ...(options.headers || {}) },
      }).then(
        (response) =>
          response.text().then((text) => {
            let body = null
            if (text) {
              try {
                body = JSON.parse(text)
              } catch (_) {
                body = null
              }
            }
            return { ok: response.ok, status: response.status, body }
          }),
        () => ({ ok: false, status: 0, body: null }),
      )
    }

    function ModePicker() {
      const [mode, setMode] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        requestMode().then((result) => {
          if (cancelled || !alive.current) return
          const body = result.ok && result.body && typeof result.body === 'object' ? result.body : null
          if (!body || (body.mode !== 'owner' && body.mode !== 'auto')) return
          setMode(body.mode)
        })
        return () => {
          cancelled = true
        }
      }, [])

      const choose = React.useCallback(
        (next) => {
          if (busy || mode === null || next === mode) return
          if (next === 'auto' && !window.confirm('开启自动模式后，龙爪将不再逐次请求确认，能够自行点击、输入和提交表单。此设置对所有会话生效。确定开启？')) return
          setBusy(true)
          requestMode({
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dragon-mode-intent': 'user' },
            body: JSON.stringify({ mode: next, acknowledge: next === 'auto' }),
          }).then((result) => {
            if (!alive.current) return
            setBusy(false)
            const body = result.ok && result.body && typeof result.body === 'object' ? result.body : null
            if (body && (body.mode === 'owner' || body.mode === 'auto')) setMode(body.mode)
          })
        },
        [busy, mode],
      )

      if (mode === null) return null

      return React.createElement(
        'span',
        {
          className: 'dsh-dragon-mode',
          role: 'group',
          'aria-label': '龙爪权限模式',
          'data-busy': busy ? 'true' : 'false',
        },
        React.createElement('span', { className: 'dsh-dragon-mode-title' }, '龙爪'),
        ...OPTIONS.map((option) =>
          React.createElement(
            'button',
            {
              key: option.value,
              type: 'button',
              className: 'dsh-dragon-mode-seg',
              'data-active': mode === option.value ? 'true' : 'false',
              'data-warn': option.value === 'auto' ? 'true' : 'false',
              'aria-pressed': mode === option.value,
              title: option.title,
              disabled: busy,
              onClick: () => choose(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /** 客户端插件契约：要 slots 才能往工具条里挂东西。 */
    const inject = ['slots']

    function apply(ctx) {
      try {
        ensureStyle()
      } catch (error) {
        console.warn('[dsh-dragon-control] style', error)
      }
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-dragon-mode',
            order: 44,
            label: '龙爪权限模式',
          },
          () => React.createElement(ModePicker),
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
