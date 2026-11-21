/**
 * dsh-opencode-session 浏览器端：设置页里的一个独立小节。
 *
 * 在设置面板左侧导航注册一项「OpenCode 会话头」，点进去是配置页：
 * 每个配置项都有标题、说明和控件；保存走宿主侧的
 * `/dsh-opencode-session/config`，由 configEditor 写回 profile 并重新装载该行，
 * 因此**不需要重启 dsh** 就生效。
 *
 * 手写 __ModuleLoader__ 工厂（无构建步骤），与宿主共享同一份 React。
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 本插件的 locale 字典命名空间。 */
    const NS = 'dsh-x-opencode-session'
    /** 宿主写入的配置端点。 */
    const ROUTE = '/dsh-opencode-session/config'

    const zh = {
      nav: 'OpenCode 会话头',
      title: 'OpenCode 会话请求头',
      intro:
        '给模型请求附加 x-opencode-session 请求头：同一会话固定、不同会话不同、重启续聊不变。保存后立即生效，无需重启 dsh。',
      statusTitle: '当前状态',
      statusOn: '生效中',
      statusOff: '未生效',
      statusHosts: '生效主机',
      statusHeader: '请求头',
      statusValue: '取值',
      statusOverride: '覆盖同名头',
      statusDebug: '调试日志',
      statusDocument: '配置写入',
      on: '开',
      off: '关',
      valueSessionId: '会话 id（session-<uuid>）',
      valueUuid: '裸 UUID',
      hostsLabel: '生效主机',
      hostsDesc:
        '只有发往这些主机的请求才附加请求头；子域自动包含（opencode.ai 命中 go.opencode.ai）。每行一个或用逗号分隔，填 * 表示所有主机。走自建 OpenCode 中转时把中转域名加进来。',
      hostsPlaceholder: 'opencode.ai',
      headerLabel: '请求头名称',
      headerDesc: '默认 x-opencode-session，OpenCode 网关按这个名字识别会话；一般不需要改。',
      valueLabel: '取值方式',
      valueDesc:
        '会话 id：直接发 dsh 的会话 id（session-<uuid>）。裸 UUID：去掉 session- 前缀。两种都与同一个会话稳定绑定。',
      overrideLabel: '覆盖已有的同名头',
      overrideDesc:
        '默认不覆盖：请求里已经带了同名头时保持原值，可与新版 pi-ai 自带的注入共存。打开后一律用当前会话的值替换，可修正 profile 里写死的静态值。',
      debugLabel: '调试日志',
      debugDesc: '打开后每次注入都记一条 debug 日志，插件启动时也会在控制台打一行，便于确认是否命中。',
      save: '保存并立即生效',
      saving: '保存中…',
      reset: '填入默认值',
      saved: '已保存，配置已即时生效（无需重启 dsh）。',
      resetTip: '已填入默认值，点上面的按钮保存后生效。',
      saveFailed: '保存失败',
      loadFailed: '读取配置失败',
      loading: '读取中…',
      unavailable: '当前 profile 没有挂载配置编辑器（configEditor），无法在这里修改配置；请编辑 profile 的 cordis.patch.yml。',
      refreshHint: '配置改动即时生效；只有插件代码更新时才需要刷新页面。',
    }

    const en = {
      nav: 'OpenCode session header',
      title: 'OpenCode session request header',
      intro:
        'Adds the x-opencode-session header to model requests: stable within a session, distinct across sessions, unchanged after restarts. Saving applies immediately — no dsh restart needed.',
      statusTitle: 'Current state',
      statusOn: 'Active',
      statusOff: 'Inactive',
      statusHosts: 'Hosts',
      statusHeader: 'Header',
      statusValue: 'Value',
      statusOverride: 'Override',
      statusDebug: 'Debug log',
      statusDocument: 'Written to',
      on: 'On',
      off: 'Off',
      valueSessionId: 'Session id (session-<uuid>)',
      valueUuid: 'Bare UUID',
      hostsLabel: 'Matching hosts',
      hostsDesc:
        'Only requests to these hosts carry the header; subdomains are included (opencode.ai matches go.opencode.ai). One per line or comma separated; * means every host. Add your own OpenCode relay host here.',
      hostsPlaceholder: 'opencode.ai',
      headerLabel: 'Header name',
      headerDesc: 'Defaults to x-opencode-session — the name the OpenCode gateway reads. Rarely needs changing.',
      valueLabel: 'Value format',
      valueDesc:
        'Session id: send dsh\u2019s conversation id as-is (session-<uuid>). Bare UUID: drop the session- prefix. Both bind to the same conversation.',
      overrideLabel: 'Replace an existing header',
      overrideDesc:
        'Off by default: keep a same-named header already present, so it coexists with newer pi-ai injection. On: always replace it with this session\u2019s value, fixing a static value pinned in the profile.',
      debugLabel: 'Debug log',
      debugDesc: 'Logs every injection at debug level and prints one console line at activation, to confirm a match.',
      save: 'Save and apply now',
      saving: 'Saving…',
      reset: 'Fill defaults',
      saved: 'Saved and applied immediately — no dsh restart required.',
      resetTip: 'Defaults filled in; press the save button to apply.',
      saveFailed: 'Save failed',
      loadFailed: 'Could not load the configuration',
      loading: 'Loading…',
      unavailable: 'This profile does not mount configEditor, so the configuration cannot be edited here; edit the profile cordis.patch.yml instead.',
      refreshHint: 'Configuration changes apply immediately; only plugin code updates need a page refresh.',
    }

    /** 主题 token（宿主深浅色自动切换）。 */
    const C = {
      ink: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      panel: 'var(--dsw-alias-bg-layer-2)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    }

    const PAGE = { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '760px', color: C.ink }
    const TITLE = { margin: 0, fontSize: '17px', fontWeight: 650, lineHeight: '1.35' }
    const INTRO = { margin: '6px 0 0', fontSize: '13px', lineHeight: '1.65', color: C.sub }
    const CARD = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '16px 18px',
      border: '1px solid ' + C.borderSoft,
      borderRadius: '12px',
      background: C.panel,
    }
    const FIELD = { display: 'flex', flexDirection: 'column', gap: '6px' }
    const FIELD_LABEL = { fontSize: '13px', fontWeight: 600, lineHeight: '1.4' }
    const FIELD_DESC = { fontSize: '12px', lineHeight: '1.65', color: C.sub }
    const CONTROL = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      fontSize: '13px',
      lineHeight: '1.5',
      color: C.ink,
      background: C.panel,
      border: '1px solid ' + C.border,
      borderRadius: '8px',
      outline: 'none',
      fontFamily: 'inherit',
    }
    const BUTTON = {
      padding: '8px 16px',
      fontSize: '13px',
      fontWeight: 600,
      borderRadius: '8px',
      border: '1px solid transparent',
      background: C.accent,
      color: '#fff',
      cursor: 'pointer',
    }
    const BUTTON_GHOST = {
      ...BUTTON,
      background: 'transparent',
      border: '1px solid ' + C.border,
      color: C.ink,
    }

    /** 一行状态摘要。 */
    function StatusRow({ label, value }) {
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '10px', fontSize: '13px', lineHeight: '1.5' } },
        h('span', { style: { color: C.sub } }, label),
        h('span', { style: { wordBreak: 'break-all' } }, value),
      )
    }

    /** 一个带标题与说明的表单项。 */
    function Field({ label, description, children }) {
      return h(
        'div',
        { style: FIELD },
        h('div', { style: FIELD_LABEL }, label),
        h('div', { style: FIELD_DESC }, description),
        children,
      )
    }

    /** 开关行：标题 + 说明 + 右侧开关。 */
    function Toggle({ label, description, checked, onChange, onText, offText }) {
      return h(
        'div',
        { style: { ...FIELD, gap: '8px' } },
        h(
          'label',
          { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: (event) => onChange(event.target.checked),
            style: { marginTop: '3px', width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer' },
          }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h(
              'span',
              { style: FIELD_LABEL },
              label,
              h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 500, color: C.sub } }, checked ? onText : offText),
            ),
            h('span', { style: FIELD_DESC }, description),
          ),
        ),
      )
    }

    /** 设置页主体。 */
    function SettingsPage({ t }) {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState(null)
      const [saving, setSaving] = useState(false)

      const applyState = useCallback((data) => {
        setState(data)
        setDraft({
          hosts: Array.isArray(data.config?.hosts) ? data.config.hosts : data.defaults.hosts,
          header: data.config?.header ?? data.defaults.header,
          value: data.config?.value ?? data.defaults.value,
          override: data.config?.override === true,
          debug: data.config?.debug === true,
        })
      }, [])

      const load = useCallback(() => {
        setNotice(null)
        fetch(ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`)
            applyState(data)
          })
          .catch((error) => setNotice({ kind: 'error', text: `${t('loadFailed')}: ${error.message}` }))
      }, [applyState, t])

      useEffect(() => {
        load()
      }, [load])

      const patch = (values) => setDraft((current) => ({ ...current, ...values }))

      const save = useCallback(() => {
        if (draft === null || saving) return
        setSaving(true)
        setNotice(null)
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ config: draft }),
        })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`)
            applyState(data)
            setNotice({ kind: 'ok', text: t('saved') })
          })
          .catch((error) => setNotice({ kind: 'error', text: `${t('saveFailed')}: ${error.message}` }))
          .finally(() => setSaving(false))
      }, [applyState, draft, saving, t])

      if (state === null) {
        return h(
          'div',
          { style: PAGE },
          h('div', { style: FIELD_DESC }, notice === null ? t('loading') : notice.text),
        )
      }

      const effective = state.effective ?? state.defaults
      const hostsText = (draft?.hosts ?? []).join('\n')

      return h(
        'div',
        { style: PAGE },
        h(
          'header',
          null,
          h('h2', { style: TITLE }, t('title')),
          h('p', { style: INTRO }, t('intro')),
        ),

        state.available === false
          ? h('div', { style: { ...CARD, borderColor: C.error } }, h('div', { style: FIELD_DESC }, t('unavailable')))
          : null,

        h(
          'section',
          { style: CARD },
          h('div', { style: { ...FIELD_LABEL, display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: C.ok, display: 'inline-block' } }),
            t('statusTitle'),
            h('span', { style: { fontSize: '12px', fontWeight: 500, color: C.sub } }, t('statusOn')),
          ),
          h(StatusRow, { label: t('statusHosts'), value: (effective.hosts ?? []).join(', ') }),
          h(StatusRow, { label: t('statusHeader'), value: effective.header }),
          h(StatusRow, {
            label: t('statusValue'),
            value: effective.value === 'uuid' ? t('valueUuid') : t('valueSessionId'),
          }),
          h(StatusRow, { label: t('statusOverride'), value: effective.override ? t('on') : t('off') }),
          h(StatusRow, { label: t('statusDebug'), value: effective.debug ? t('on') : t('off') }),
          state.documentPath ? h(StatusRow, { label: t('statusDocument'), value: state.documentPath }) : null,
        ),

        h(
          'section',
          { style: CARD },
          h(
            Field,
            { label: t('hostsLabel'), description: t('hostsDesc') },
            h('textarea', {
              style: { ...CONTROL, minHeight: '84px', resize: 'vertical', fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: '12.5px' },
              rows: 3,
              spellCheck: false,
              placeholder: t('hostsPlaceholder'),
              value: hostsText,
              onChange: (event) => patch({ hosts: event.target.value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean) }),
            }),
          ),
          h(
            Field,
            { label: t('headerLabel'), description: t('headerDesc') },
            h('input', {
              style: { ...CONTROL, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: '12.5px' },
              type: 'text',
              spellCheck: false,
              value: draft.header,
              onChange: (event) => patch({ header: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('valueLabel'), description: t('valueDesc') },
            h(
              'select',
              {
                style: { ...CONTROL, cursor: 'pointer' },
                value: draft.value,
                onChange: (event) => patch({ value: event.target.value }),
              },
              h('option', { value: 'session-id' }, t('valueSessionId')),
              h('option', { value: 'uuid' }, t('valueUuid')),
            ),
          ),
          h(Toggle, {
            label: t('overrideLabel'),
            description: t('overrideDesc'),
            checked: draft.override,
            onChange: (checked) => patch({ override: checked }),
            onText: t('on'),
            offText: t('off'),
          }),
          h(Toggle, {
            label: t('debugLabel'),
            description: t('debugDesc'),
            checked: draft.debug,
            onChange: (checked) => patch({ debug: checked }),
            onText: t('on'),
            offText: t('off'),
          }),
        ),

        h(
          'footer',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: saving ? { ...BUTTON, opacity: 0.6, cursor: 'default' } : BUTTON, onClick: save, disabled: saving }, saving ? t('saving') : t('save')),
          h(
            'button',
            {
              type: 'button',
              style: BUTTON_GHOST,
              onClick: () => {
                patch({
                  hosts: [...state.defaults.hosts],
                  header: state.defaults.header,
                  value: state.defaults.value,
                  override: state.defaults.override === true,
                  debug: state.defaults.debug === true,
                })
                setNotice({ kind: 'info', text: t('resetTip') })
              },
            },
            t('reset'),
          ),
          notice === null
            ? null
            : h(
                'span',
                {
                  style: {
                    fontSize: '12.5px',
                    lineHeight: '1.5',
                    color: notice.kind === 'error' ? C.error : notice.kind === 'ok' ? C.ok : C.sub,
                  },
                },
                notice.text,
              ),
        ),

        h('div', { style: { ...FIELD_DESC, fontSize: '11.5px' } }, t('refreshHint')),
      )
    }

    const inject = ['slots', 'locale']

    /** 挂载设置小节。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'x-opencode-session: locale dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'opencode-session',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          },
          () => h(SettingsPage, { t }),
        ),
      )
    }

    return { apply, inject }
  },
})
