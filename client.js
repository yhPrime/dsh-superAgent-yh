// dsh-superAgent-yh 应用内控制台（左侧栏主面板 + 右侧栏页签）。
// 浏览器模块：React 从宿主模块表取，不重复安装；所有数据走 host 的 /dsh-superagent-yh/* 路由。
window.__ModuleLoader__.load({
  id: 'dsh-superagent-yh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-superagent-yh'
    const BASE = '/dsh-superagent-yh'
    const PANEL_ID = NS

    const DICT = {
      zh: {
        title: 'Superagent 控制台',
        subtitle: '每个工单独立会话与目录；主线只收三条短消息',
        refresh: '刷新', close: '关闭', openRight: '在右栏打开', openConsole: '打开完整控制台',
        queued: '待处理', running: '进行中', waiting: '等进行人', done: '完成', failed: '失败',
        tickets: '工单', noTickets: '还没有工单。先在下面启用一个源。',
        source: '源', status: '状态', attempts: '尝试', lastError: '最后错误', actions: '操作',
        retry: '重试', cancel: '取消', session: '会话', log: '日志', closeLog: '收起日志',
        settings: '设置', basic: '基础', dryRun: 'dryRun（只记录不干活）', mainSession: '主线会话 ID',
        poll: '轮询间隔(ms)', preset: 'worker preset', save: '保存', saving: '保存中…', saved: '已保存（插件会重载）',
        github: 'GitHub', feishu: '飞书', qq: 'QQ', enabled: '启用', repo: '仓库 owner/name',
        labels: '触发标签（逗号分隔）', authors: '作者白名单（逗号分隔）', token: 'Token（留空保持）',
        tokenSet: '已配置，留空保持不变', tokenUnset: '未配置', apiBase: 'API 地址', confirmWrites: '允许回写',
        appId: 'App ID', appSecret: 'App Secret（留空保持）', chatIds: '群 chat_id（逗号分隔）', requireMention: '必须 @',
        mode: '模式', personal: '个人号（OneBot v11）', official: '官方机器人（roost-host/1）',
        selfId: '机器人 QQ 号', httpUrl: 'OneBot HTTP 地址', wsUrl: 'OneBot WS 地址',
        host: '主机', port: '端口', guide: '查看工单三态、操作与源配置',
        loadFailed: '加载失败', noHostService: '当前宿主没有这个服务', closeHint: '关闭后可从左侧栏图标重新打开',
      },
      en: {
        title: 'Superagent console',
        subtitle: 'One session and directory per ticket; the main line gets three short messages',
        refresh: 'Refresh', close: 'Close', openRight: 'Open in right bar', openConsole: 'Open full console',
        queued: 'Queued', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed',
        tickets: 'Tickets', noTickets: 'No tickets yet. Enable a source below.',
        source: 'Source', status: 'Status', attempts: 'Attempts', lastError: 'Last error', actions: 'Actions',
        retry: 'Retry', cancel: 'Cancel', session: 'Session', log: 'Log', closeLog: 'Hide log',
        settings: 'Settings', basic: 'Basics', dryRun: 'dryRun (record only)', mainSession: 'Main session id',
        poll: 'Poll interval (ms)', preset: 'worker preset', save: 'Save', saving: 'Saving…', saved: 'Saved (plugin reloads)',
        github: 'GitHub', feishu: 'Feishu', qq: 'QQ', enabled: 'Enabled', repo: 'Repository owner/name',
        labels: 'Trigger labels (comma separated)', authors: 'Author allowlist (comma separated)', token: 'Token (blank keeps current)',
        tokenSet: 'Configured; blank keeps it', tokenUnset: 'Not set', apiBase: 'API base', confirmWrites: 'Allow write-back',
        appId: 'App ID', appSecret: 'App secret (blank keeps current)', chatIds: 'Chat ids (comma separated)', requireMention: 'Require @',
        mode: 'Mode', personal: 'Personal (OneBot v11)', official: 'Official (roost-host/1)',
        selfId: 'Bot QQ id', httpUrl: 'OneBot HTTP URL', wsUrl: 'OneBot WS URL',
        host: 'Host', port: 'Port', guide: 'Ticket states, actions, and source settings',
        loadFailed: 'Load failed', noHostService: 'Host service unavailable', closeHint: 'Reopen from the left sidebar icon',
      },
    }

    const split = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)

    function useT(ctx) {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => ctx.locale.subscribe(() => force()), [ctx])
      return ctx.locale.bind(NS)
    }

    function useStatus(ctx) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(`${BASE}/status`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState({ loading: false, data, error: null })
        } catch (error) {
          setState({ loading: false, data: null, error: String(error?.message || error) })
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) load() }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])
      return { ...state, reload: load }
    }

    async function post(path, body) {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superagent': '1' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function buildForm(config) {
      const g = config.sources.github
      const f = config.sources.feishu
      const q = config.sources.qq
      return {
        dryRun: config.dryRun,
        mainSessionId: config.mainSessionId || '',
        pollIntervalMs: String(config.pollIntervalMs),
        workerPreset: config.workerPreset || '',
        github: { enabled: g.enabled, repo: g.repo || '', labels: (g.labels || []).join(', '), authors: (g.authors || []).join(', '), apiBase: g.apiBase || '', confirmWrites: g.confirmWrites, token: '', hasToken: g.hasToken },
        feishu: { enabled: f.enabled, appId: f.appId || '', chatIds: (f.chatIds || []).join(', '), authors: (f.authors || []).join(', '), requireMention: f.requireMention, confirmWrites: f.confirmWrites, appSecret: '', hasSecret: f.hasSecret },
        qq: {
          enabled: q.enabled, mode: q.mode || 'official', requireAt: q.requireAt, authors: (q.authors || []).join(', '), allowedGroups: (q.allowedGroups || []).join(', '), confirmWrites: q.confirmWrites,
          personal: { httpUrl: q.personal?.httpUrl || '', wsUrl: q.personal?.wsUrl || '', selfId: q.personal?.selfId || '', snowLumaDir: q.personal?.snowLumaDir || '', hasHttpToken: q.personal?.hasHttpToken, hasWsToken: q.personal?.hasWsToken },
          official: { host: q.official?.host || '127.0.0.1', port: String(q.official?.port || 0), hasToken: q.official?.hasToken, token: '' },
        },
      }
    }

    function formPayload(form) {
      return {
        dryRun: form.dryRun,
        mainSessionId: form.mainSessionId,
        pollIntervalMs: Number(form.pollIntervalMs) || 60000,
        workerPreset: form.workerPreset,
        sources: {
          github: { enabled: form.github.enabled, repo: form.github.repo, labels: split(form.github.labels), authors: split(form.github.authors), apiBase: form.github.apiBase, confirmWrites: form.github.confirmWrites, token: form.github.token },
          feishu: { enabled: form.feishu.enabled, appId: form.feishu.appId, chatIds: split(form.feishu.chatIds), authors: split(form.feishu.authors), requireMention: form.feishu.requireMention, confirmWrites: form.feishu.confirmWrites, appSecret: form.feishu.appSecret },
          qq: {
            enabled: form.qq.enabled, mode: form.qq.mode, requireAt: form.qq.requireAt, authors: split(form.qq.authors), allowedGroups: split(form.qq.allowedGroups), confirmWrites: form.qq.confirmWrites,
            personal: { httpUrl: form.qq.personal.httpUrl, wsUrl: form.qq.personal.wsUrl, selfId: form.qq.personal.selfId, snowLumaDir: form.qq.personal.snowLumaDir },
            official: { host: form.qq.official.host, port: Number(form.qq.official.port) || 0 },
          },
        },
      }
    }

    const CSS = `
.syh-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.syh-wrap{padding:20px 24px;max-width:1100px}
.syh-compact{padding:12px 14px}
.syh-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.syh-head h1{font-size:18px;margin:0;font-weight:600}
.syh-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.syh-grow{flex:1}
.syh-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}
.syh-btn:hover{border-color:var(--dsw-alias-border-l2)}
.syh-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.syh-btn-danger{color:var(--dsw-alias-state-error-primary)}
.syh-stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.syh-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 12px;min-width:78px}
.syh-stat b{display:block;font-size:17px}
.syh-stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.syh-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.syh-card h2{font-size:14px;margin:0 0 10px;font-weight:600;display:flex;align-items:center;gap:8px}
.syh-table{width:100%;border-collapse:collapse;font-size:12px}
.syh-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.syh-table td{padding:6px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.syh-badge{display:inline-block;border-radius:999px;padding:0 8px;line-height:19px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.syh-queued{color:var(--dsw-alias-state-warn-primary)}.syh-running{color:var(--dsw-alias-brand-primary)}.syh-waiting{color:var(--dsw-alias-state-warn-primary)}.syh-done{color:var(--dsw-alias-state-success-primary)}.syh-failed{color:var(--dsw-alias-state-error-primary)}
.syh-err{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-all}
.syh-muted{color:var(--dsw-alias-label-secondary)}
.syh-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px}
.syh-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.syh-field input[type=text],.syh-field input[type=password],.syh-field input[type=number],.syh-field select{min-width:150px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.syh-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.syh-pre{max-height:280px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.syh-src{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;margin-top:10px}
.syh-src:first-of-type{border-top:0;padding-top:0;margin-top:0}
.syh-src-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-weight:600;font-size:13px}
.syh-msg{font-size:12px;margin-left:8px;color:var(--dsw-alias-state-success-primary)}
`

    function Badge({ status }) {
      return h('span', { className: `syh-badge syh-${status}` }, status)
    }

    function Stat({ label, value }) {
      return h('div', { className: 'syh-stat' }, h('b', null, String(value ?? 0)), h('span', null, label))
    }

    function Field({ label, children }) {
      return h('label', { className: 'syh-field' }, label, children)
    }

    function TextInput({ value, onChange, placeholder, type = 'text' }) {
      return h('input', { type, value: value ?? '', placeholder, onChange: (event) => onChange(event.target.value) })
    }

    function Check({ label, checked, onChange }) {
      return h('label', { className: 'syh-check' }, h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }), label)
    }

    function Console({ ctx, compact = false, onClose }) {
      const t = useT(ctx)
      const { data, error: loadError, reload } = useStatus(ctx)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [error, setError] = React.useState('')
      const [log, setLog] = React.useState(null)

      React.useEffect(() => {
        if (data?.config && form === null) setForm(buildForm(data.config))
      }, [data, form])

      const setField = (path, value) => {
        setForm((current) => {
          if (!current) return current
          const next = structuredClone(current)
          const keys = path.split('.')
          let target = next
          for (let i = 0; i < keys.length - 1; i += 1) target = target[keys[i]]
          target[keys[keys.length - 1]] = value
          return next
        })
      }

      const run = async (fn, okMessage) => {
        setMsg('')
        setError('')
        try {
          await fn()
          if (okMessage) setMsg(okMessage)
          await reload()
        } catch (reason) {
          setError(String(reason?.message || reason))
        }
      }

      const save = () => run(async () => {
        setMsg(t('saving'))
        await post('/settings', formPayload(form))
        setMsg(t('saved'))
        setForm(null)
      })

      const act = (ticket, action) => run(() => post('/action', { ticketId: ticket.id, action }))

      const openSession = (ticket) => {
        const workspace = ctx.get('uiWorkspace')
        if (!workspace?.openSession) { setError(t('noHostService')); return }
        try { workspace.openSession(ticket.sessionId) } catch (reason) { setError(String(reason?.message || reason)) }
      }

      const showLog = (ticket) => run(async () => {
        const response = await fetch(`${BASE}/log?ticketId=${encodeURIComponent(ticket.id)}`, { cache: 'no-store' })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
        setLog({ id: ticket.id, text: body.text, truncated: body.truncated })
      })

      const openRight = () => {
        const right = ctx.get('sidebarRight')
        if (!right?.openTab) { setError(t('noHostService')); return }
        try { right.openTab(NS) } catch (reason) { setError(String(reason?.message || reason)) }
      }

      const stats = data?.stats ?? { queued: 0, running: 0, waiting: 0, done: 0, failed: 0 }
      const tickets = [...(data?.tickets ?? [])].reverse()
      const shown = compact ? tickets.slice(0, 6) : tickets

      const header = h('div', { className: 'syh-head' },
        h('div', { className: 'syh-grow' },
          h('h1', null, t('title'), ' ', h('span', { className: 'syh-muted', style: { fontSize: 11 } }, 'v' + (data?.config?.version || ''))),
          h('div', { className: 'syh-sub' }, t('subtitle')),
        ),
        h('button', { className: 'syh-btn', onClick: () => reload() }, t('refresh')),
        compact
          ? h('button', { className: 'syh-btn syh-btn-primary', onClick: () => ctx.layout.selectPanel(PANEL_ID) }, t('openConsole'))
          : h('button', { className: 'syh-btn', onClick: openRight }, t('openRight')),
        h('button', { className: 'syh-btn', onClick: () => onClose?.() }, t('close')),
      )

      const statsRow = h('div', { className: 'syh-stats' },
        h(Stat, { label: t('queued'), value: stats.queued }),
        h(Stat, { label: t('running'), value: stats.running }),
        h(Stat, { label: t('waiting'), value: stats.waiting }),
        h(Stat, { label: t('done'), value: stats.done }),
        h(Stat, { label: t('failed'), value: stats.failed }),
      )

      const errorBox = (loadError || error || data?.lastError) ? h('div', { className: 'syh-card' },
        loadError ? h('div', { className: 'syh-err' }, t('loadFailed') + '：' + loadError) : null,
        error ? h('div', { className: 'syh-err' }, error) : null,
        data?.lastError ? h('div', { className: 'syh-err' }, t('lastError') + '：' + data.lastError) : null,
      ) : null

      const ticketTable = h('div', { className: 'syh-card' },
        h('h2', null, t('tickets'), h('span', { className: 'syh-muted' }, ' (' + tickets.length + ')')),
        tickets.length === 0
          ? h('div', { className: 'syh-muted' }, t('noTickets'))
          : h('table', { className: 'syh-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('tickets')),
                h('th', null, t('status')),
                h('th', null, t('attempts')),
                h('th', null, t('lastError')),
                h('th', null, t('actions')),
              )),
              h('tbody', null, shown.map((ticket) => h('tr', { key: ticket.id },
                h('td', null,
                  h('code', { style: { fontSize: 11 } }, ticket.id),
                  h('div', { style: { fontSize: 12 } }, ticket.title || ''),
                  ticket.question ? h('div', { className: 'syh-err', style: { fontSize: 11 } }, '？' + ticket.question) : null,
                ),
                h('td', null, h(Badge, { status: ticket.status })),
                h('td', null, String(ticket.attempts ?? 0)),
                h('td', null, ticket.lastError ? h('div', { className: 'syh-err' }, ticket.lastError) : h('span', { className: 'syh-muted' }, '—')),
                h('td', null,
                  ticket.status === 'failed' ? h('button', { className: 'syh-btn', onClick: () => act(ticket, 'retry') }, t('retry')) : null,
                  (ticket.status === 'running' || ticket.status === 'waiting') ? h('button', { className: 'syh-btn syh-btn-danger', onClick: () => act(ticket, 'cancel') }, t('cancel')) : null,
                  ticket.sessionId ? h('button', { className: 'syh-btn', onClick: () => openSession(ticket) }, t('session')) : null,
                  h('button', { className: 'syh-btn', onClick: () => showLog(ticket) }, t('log')),
                ),
              ))),
            ),
        log ? h('div', null,
          h('div', { className: 'syh-row', style: { marginTop: 10 } }, h('strong', { style: { fontSize: 12 } }, log.id), h('button', { className: 'syh-btn', onClick: () => setLog(null) }, t('closeLog'))),
          h('pre', { className: 'syh-pre' }, (log.truncated ? '…（只显示最后 200 行）\n' : '') + log.text),
        ) : null,
      )

      if (compact) {
        return h('div', { className: 'syh-root syh-compact' },
          h('style', null, CSS),
          header, statsRow, errorBox, ticketTable,
          h('div', { className: 'syh-muted', style: { fontSize: 11 } }, t('closeHint')),
        )
      }

      const settings = form ? h('div', { className: 'syh-card' },
        h('h2', null, t('settings')),
        h('div', { className: 'syh-row' },
          h(Check, { label: t('dryRun'), checked: form.dryRun, onChange: (v) => setField('dryRun', v) }),
          h(Field, { label: t('mainSession') }, h(TextInput, { value: form.mainSessionId, onChange: (v) => setField('mainSessionId', v) })),
          h(Field, { label: t('poll') }, h(TextInput, { type: 'number', value: form.pollIntervalMs, onChange: (v) => setField('pollIntervalMs', v) })),
          h(Field, { label: t('preset') }, h(TextInput, { value: form.workerPreset, onChange: (v) => setField('workerPreset', v) })),
        ),
        sourceBlock('github', t('github'), form.github, (key, value) => setField('github.' + key, value), [
          ['repo', t('repo')], ['labels', t('labels')], ['authors', t('authors')], ['apiBase', t('apiBase')],
        ], t('tokenSet'), t('tokenUnset')),
        sourceBlock('feishu', t('feishu'), form.feishu, (key, value) => setField('feishu.' + key, value), [
          ['appId', t('appId')], ['chatIds', t('chatIds')], ['authors', t('authors')],
        ], t('tokenSet'), t('tokenUnset')),
        qqBlock(),
        h('div', { className: 'syh-row', style: { marginTop: 4 } },
          h('button', { className: 'syh-btn syh-btn-primary', onClick: save }, t('save')),
          msg ? h('span', { className: 'syh-msg' }, msg) : null,
        ),
      ) : h('div', { className: 'syh-card syh-muted' }, t('loadFailed'))

      function sourceBlock(kind, label, section, set, fields, tokenSetText, tokenUnsetText) {
        return h('div', { className: 'syh-src' },
          h('div', { className: 'syh-src-head' }, label, h(Check, { label: t('enabled'), checked: section.enabled, onChange: (v) => set('enabled', v) }), h(Check, { label: t('confirmWrites'), checked: section.confirmWrites, onChange: (v) => set('confirmWrites', v) })),
          h('div', { className: 'syh-row' }, fields.map(([key, fieldLabel]) => h(Field, { key, label: fieldLabel }, h(TextInput, { value: section[key], onChange: (v) => set(key, v) })))),
          kind === 'github' ? h('div', { className: 'syh-row' },
            h(Field, { label: t('token') }, h(TextInput, { type: 'password', value: section.token, placeholder: section.hasToken ? tokenSetText : tokenUnsetText, onChange: (v) => set('token', v) })),
          ) : null,
          kind === 'feishu' ? h('div', { className: 'syh-row' },
            h(Field, { label: t('appSecret') }, h(TextInput, { type: 'password', value: section.appSecret, placeholder: section.hasSecret ? tokenSetText : tokenUnsetText, onChange: (v) => set('appSecret', v) })),
          ) : null,
        )
      }

      function qqBlock() {
        const q = form.qq
        return h('div', { className: 'syh-src' },
          h('div', { className: 'syh-src-head' }, t('qq'),
            h(Check, { label: t('enabled'), checked: q.enabled, onChange: (v) => setField('qq.enabled', v) }),
            h(Field, { label: t('mode') }, h('select', { value: q.mode, onChange: (e) => setField('qq.mode', e.target.value) },
              h('option', { value: 'personal' }, t('personal')),
              h('option', { value: 'official' }, t('official')),
            )),
            h(Check, { label: t('requireAt'), checked: q.requireAt, onChange: (v) => setField('qq.requireAt', v) }),
            h(Check, { label: t('confirmWrites'), checked: q.confirmWrites, onChange: (v) => setField('qq.confirmWrites', v) }),
          ),
          h('div', { className: 'syh-row' },
            h(Field, { label: t('authors') }, h(TextInput, { value: q.authors, onChange: (v) => setField('qq.authors', v) })),
            h(Field, { label: t('labels') }, h(TextInput, { value: q.allowedGroups, onChange: (v) => setField('qq.allowedGroups', v) })),
          ),
          q.mode === 'personal'
            ? h('div', { className: 'syh-row' },
                h(Field, { label: t('httpUrl') }, h(TextInput, { value: q.personal.httpUrl, onChange: (v) => setField('qq.personal.httpUrl', v) })),
                h(Field, { label: t('wsUrl') }, h(TextInput, { value: q.personal.wsUrl, onChange: (v) => setField('qq.personal.wsUrl', v) })),
                h(Field, { label: t('selfId') }, h(TextInput, { value: q.personal.selfId, onChange: (v) => setField('qq.personal.selfId', v) })),
              )
            : h('div', { className: 'syh-row' },
                h(Field, { label: t('host') }, h(TextInput, { value: q.official.host, onChange: (v) => setField('qq.official.host', v) })),
                h(Field, { label: t('port') }, h(TextInput, { type: 'number', value: q.official.port, onChange: (v) => setField('qq.official.port', v) })),
                h(Field, { label: t('token') }, h(TextInput, { type: 'password', value: q.official.token, placeholder: q.official.hasToken ? t('tokenSet') : t('tokenUnset'), onChange: (v) => setField('qq.official.token', v) })),
              ),
        )
      }

      return h('div', { className: 'syh-root' },
        h('style', null, CSS),
        h('div', { className: 'syh-wrap' }, header, statsRow, errorBox, ticketTable, settings),
      )
    }

    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2, y: 3.5, width: 12, height: 9, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 6, cy: 7.6, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 10, cy: 7.6, r: 1, fill: 'currentColor' }),
        h('path', { d: 'M5.6 10.6c.8.8 1.6 1.1 2.4 1.1s1.6-.3 2.4-1.1', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
      )
    }

    function RightBody(props) {
      const ctx = props.ctx
      const close = () => {
        try { props?.hooks?.tabInfo?.().tab?.actions?.close?.() } catch { /* 原生关闭按钮仍可用 */ }
      }
      return h(Console, { ctx, compact: true, onClose: close })
    }

    function MainPanel(props) {
      return h(Console, { ctx: props.ctx, onClose: () => props.ctx.layout.selectPanel(null) })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ ctx }),
        }, MainPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 26,
          label: () => ctx.locale.bind(NS)('title'),
          locale: NS,
        }, Icon))

        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (child) => {
          const tabs = child.get('sidebarRightTabs') ?? child.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          child.effect(() => tabs.register({
            id: NS,
            kind: NS,
            priority: 'extension',
            title: () => child.locale.bind(NS)('title'),
            guide: [{ id: 'console', order: 42, title: () => child.locale.bind(NS)('title'), description: () => child.locale.bind(NS)('guide'), icon: Icon }],
          }))
          child.slots.inject('sidebar.right.pane.tab', () => child.slots.register({
            name: 'sidebar.right.pane.tab',
            key: NS,
            inject: () => ({ ctx: child }),
          }, RightBody))
          child.slots.inject('sidebar.right.pane.tab.title', () => child.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: NS,
            inject: () => ({ ctx: child }),
          }, (props) => h('span', null, props.ctx.locale.bind(NS)('title'))))
        })
      },
    }
  },
})
