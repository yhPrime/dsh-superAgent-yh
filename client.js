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
    const TABS = ['overview', 'tickets', 'sources', 'settings']

    const DICT = {
      zh: {
        title: 'Superagent 控制台',
        subtitle: '每个工单独立会话与目录；主线只收三条短消息',
        overview: '概览', ticketsTab: '工单', sourcesTab: '源', settingsTab: '设置',
        refresh: '刷新', close: '关闭', openRight: '在右栏打开', openConsole: '打开完整控制台',
        queued: '待处理', running: '进行中', waiting: '等进行人', done: '完成', failed: '失败',
        all: '全部', search: '搜索工单 id / 标题', noMatch: '没有匹配的工单',
        tickets: '工单', noTickets: '还没有工单。先在「源」里启用一个源。',
        source: '来源', status: '状态', attempts: '尝试', lastError: '最后错误', actions: '操作',
        retry: '重试', cancel: '取消', session: '会话', log: '日志', closeLog: '收起日志',
        settings: '设置', basic: '基础', dryRun: 'dryRun（只记录不干活）', mainSession: '主线会话 ID',
        poll: '轮询间隔(ms)', preset: 'worker preset', repoPath: '本地 git 仓库路径（worker worktree 源）',
        save: '保存', saving: '保存中…', saved: '已保存（插件会重载）', unsaved: '有未保存的修改',
        github: 'GitHub', feishu: '飞书', qq: 'QQ', enabled: '启用', repo: '仓库 owner/name',
        labels: '触发标签（逗号分隔）', authors: '作者白名单（逗号分隔）', token: 'Token（留空保持）',
        tokenSet: '已配置，留空保持不变', tokenUnset: '未配置', apiBase: 'API 地址', confirmWrites: '允许回写',
        appId: 'App ID', appSecret: 'App Secret（留空保持）', chatIds: '群 chat_id（逗号分隔）', requireMention: '必须 @',
        mode: '模式', personal: '个人号（OneBot v11）', official: '官方机器人（roost-host/1）',
        selfId: '机器人 QQ 号', httpUrl: 'OneBot HTTP 地址', wsUrl: 'OneBot WS 地址',
        qqSenders: '只收这些发送者（QQ 号/openid，逗号分隔；空=不限）', qqTargets: '只收这些群/好友会话（群号/openid，逗号分隔；空=不限）',
        host: '主机', port: '端口', guide: '看工单三态、操作与源配置',
        loadFailed: '加载失败', noHostService: '当前宿主没有这个服务', closeHint: '关闭后可从左侧栏图标重新打开',
        workspace: '工作空间', wsPath: '目录', wsSession: '接单会话', wsPressure: '上下文占用',
        wsLastCompact: '上次压缩', wsNever: '还没压缩过', wsMissing: '无接单会话', wsRunning: '运行中',
        compactNow: '立即压缩', compacting: '压缩中…', compactOk: '已压缩', compactSkip: '宿主判断无需压缩',
        noWorkspace: '还没有登记单会话的工作区。在某个工作区新建会话，点亮输入区的「超级智能体」胶囊即可。',
        singleTitle: '单会话模式', singleHint: '每个工作空间只保留一个接单会话；空闲或上下文超阈值时自动压缩旧上下文。worker 仍每工单独立。',
        singleEnabled: '启用单会话模式', idleMinutes: '空闲多少分钟后压缩', pressureRatio: '上下文占用超过此比例也压缩',
        aggressive: '超级压缩（只保留最近几轮）', keepRecentTurns: '超级压缩保留最近几轮', autoCreate: '没有接单会话时自动创建',
        sessionIdPrefix: '会话 id 前缀',
        recent: '最近活动', sourceHealth: '源健康', noSources: '还没有启用任何源。',
        stateOk: '正常', stateFail: '异常', watermark: '水位', added: '本轮新增',
        confirmCompact: '压缩可能消耗一次模型调用，确定现在压缩？',
        boardTitle: 'Superagent 工单', boardRunning: '进行中 {count}', boardPending: '待处理 {count}', boardTotal: '共 {count}',
        capsule: '单会话', capsuleOn: '单会话已开：各工作区的接单会话已顶置', capsuleOff: '单会话已关：已取消顶置',
        pill: '超级智能体', pillTip: '点亮：把本会话设为本工作区的单会话', pillOnTip: '本工作区已登记这个单会话；删除请到控制台',
      },
      en: {
        title: 'Superagent console',
        subtitle: 'One session and directory per ticket; the main line gets three short messages',
        overview: 'Overview', ticketsTab: 'Tickets', sourcesTab: 'Sources', settingsTab: 'Settings',
        refresh: 'Refresh', close: 'Close', openRight: 'Open in right bar', openConsole: 'Open full console',
        queued: 'Queued', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed',
        all: 'All', search: 'Search id / title', noMatch: 'No matching tickets',
        tickets: 'Tickets', noTickets: 'No tickets yet. Enable a source in Sources.',
        source: 'Source', status: 'Status', attempts: 'Attempts', lastError: 'Last error', actions: 'Actions',
        retry: 'Retry', cancel: 'Cancel', session: 'Session', log: 'Log', closeLog: 'Hide log',
        settings: 'Settings', basic: 'Basics', dryRun: 'dryRun (record only)', mainSession: 'Main session id',
        poll: 'Poll interval (ms)', preset: 'worker preset', repoPath: 'Local git repo path (worktree source)',
        save: 'Save', saving: 'Saving…', saved: 'Saved (plugin reloads)', unsaved: 'Unsaved changes',
        github: 'GitHub', feishu: 'Feishu', qq: 'QQ', enabled: 'Enabled', repo: 'Repository owner/name',
        labels: 'Trigger labels (comma separated)', authors: 'Author allowlist (comma separated)', token: 'Token (blank keeps current)',
        tokenSet: 'Configured; blank keeps it', tokenUnset: 'Not set', apiBase: 'API base', confirmWrites: 'Allow write-back',
        appId: 'App ID', appSecret: 'App secret (blank keeps current)', chatIds: 'Chat ids (comma separated)', requireMention: 'Require @',
        mode: 'Mode', personal: 'Personal (OneBot v11)', official: 'Official (roost-host/1)',
        selfId: 'Bot QQ id', httpUrl: 'OneBot HTTP URL', wsUrl: 'OneBot WS URL',
        qqSenders: 'Only these senders (QQ id/openid, comma separated; empty = any)', qqTargets: 'Only these groups/chats (group id/openid, comma separated; empty = any)',
        host: 'Host', port: 'Port', guide: 'Ticket states, actions, and source settings',
        loadFailed: 'Load failed', noHostService: 'Host service unavailable', closeHint: 'Reopen from the left sidebar icon',
        workspace: 'Workspace', wsPath: 'Path', wsSession: 'Intake session', wsPressure: 'Context usage',
        wsLastCompact: 'Last compact', wsNever: 'never', wsMissing: 'no intake session', wsRunning: 'running',
        compactNow: 'Compact now', compacting: 'Compacting…', compactOk: 'Compacted', compactSkip: 'Host says nothing to compact',
        noWorkspace: 'No workspace has a registered single session yet. Create a session in a workspace and turn on the "Superagent" pill in its input area.',
        singleTitle: 'Single-session mode', singleHint: 'Each workspace keeps one intake session; old context is compacted when idle or over the threshold. Workers stay per-ticket.',
        singleEnabled: 'Enable single-session mode', idleMinutes: 'Compact after idle (minutes)', pressureRatio: 'Compact when context usage exceeds',
        aggressive: 'Aggressive (keep only recent turns)', keepRecentTurns: 'Turns to keep when aggressive', autoCreate: 'Create an intake session when missing',
        sessionIdPrefix: 'Session id prefix',
        recent: 'Recent activity', sourceHealth: 'Source health', noSources: 'No source enabled yet.',
        stateOk: 'OK', stateFail: 'Error', watermark: 'Watermark', added: 'Added',
        confirmCompact: 'Compacting may cost one model call. Compact now?',
        boardTitle: 'Superagent tickets', boardRunning: '{count} running', boardPending: '{count} queued', boardTotal: '{count} total',
        capsule: 'Single session', capsuleOn: 'Single session on: intake sessions pinned to the top', capsuleOff: 'Single session off: pins removed',
        pill: 'Superagent', pillTip: 'Turn on: make this session the single session of this workspace', pillOnTip: 'Registered as this workspace single session; delete from the console',
      },
    }

    const split = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
    const services = { right: null, workspace: null }

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

    function buildForm(config, singleSession) {
      const g = config.sources.github
      const f = config.sources.feishu
      const q = config.sources.qq
      return {
        dryRun: config.dryRun,
        mainSessionId: config.mainSessionId || '',
        repoPath: config.repoPath || '',
        pollIntervalMs: String(config.pollIntervalMs),
        workerPreset: config.workerPreset || '',
        github: { enabled: g.enabled, repo: g.repo || '', labels: (g.labels || []).join(', '), authors: (g.authors || []).join(', '), apiBase: g.apiBase || '', confirmWrites: g.confirmWrites, token: '', hasToken: g.hasToken },
        feishu: { enabled: f.enabled, appId: f.appId || '', chatIds: (f.chatIds || []).join(', '), authors: (f.authors || []).join(', '), requireMention: f.requireMention, confirmWrites: f.confirmWrites, appSecret: '', hasSecret: f.hasSecret },
        qq: {
          enabled: q.enabled, mode: q.mode || 'official', requireAt: q.requireAt, authors: (q.authors || []).join(', '), allowedGroups: (q.allowedGroups || []).join(', '), confirmWrites: q.confirmWrites,
          personal: { httpUrl: q.personal?.httpUrl || '', wsUrl: q.personal?.wsUrl || '', selfId: q.personal?.selfId || '', snowLumaDir: q.personal?.snowLumaDir || '', hasHttpToken: q.personal?.hasHttpToken, hasWsToken: q.personal?.hasWsToken },
          official: { host: q.official?.host || '127.0.0.1', port: String(q.official?.port || 0), hasToken: q.official?.hasToken, token: '' },
        },
        single: {
          enabled: singleSession?.enabled === true,
          idleMinutes: String(singleSession?.idleMinutes ?? 30),
          pressureRatio: String(singleSession?.pressureRatio ?? 0.5),
          aggressive: singleSession?.aggressive === true,
          keepRecentTurns: String(singleSession?.keepRecentTurns ?? 2),
          autoCreate: singleSession?.autoCreate !== false,
          sessionIdPrefix: singleSession?.sessionIdPrefix || 'intake',
        },
      }
    }

    function formPayload(form) {
      return {
        dryRun: form.dryRun,
        mainSessionId: form.mainSessionId,
        repoPath: form.repoPath,
        pollIntervalMs: Number(form.pollIntervalMs) || 60000,
        workerPreset: form.workerPreset,
        singleSession: {
          enabled: form.single.enabled,
          idleMinutes: Number(form.single.idleMinutes) || 30,
          pressureRatio: Number(form.single.pressureRatio) || 0.5,
          aggressive: form.single.aggressive,
          keepRecentTurns: Number(form.single.keepRecentTurns) || 0,
          autoCreate: form.single.autoCreate,
          sessionIdPrefix: form.single.sessionIdPrefix,
        },
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
.syh-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
.syh-head h1{font-size:18px;margin:0;font-weight:600}
.syh-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.syh-grow{flex:1}
.syh-live{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:8px}
.syh-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.syh-dot.dry{background:var(--dsw-alias-state-warn-primary)}
.syh-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.syh-btn:hover{border-color:var(--dsw-alias-border-l2)}
.syh-btn:disabled{opacity:.5;cursor:default}
.syh-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.syh-btn-danger{color:var(--dsw-alias-state-error-primary)}
.syh-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:16px}
.syh-tab{border:0;background:none;color:var(--dsw-alias-label-secondary);padding:8px 12px;font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent}
.syh-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.syh-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-bottom:14px}
.syh-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 12px;cursor:pointer;text-align:left;font:inherit;color:inherit}
.syh-stat:hover{border-color:var(--dsw-alias-border-l2)}
.syh-stat b{display:block;font-size:19px;line-height:1.2}
.syh-stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.syh-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.syh-card h2{font-size:14px;margin:0 0 10px;font-weight:600;display:flex;align-items:center;gap:8px}
.syh-table{width:100%;border-collapse:collapse;font-size:12px}
.syh-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.syh-table td{padding:7px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.syh-table tr:hover td{background:var(--dsw-alias-bg-layer-2)}
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
.syh-src-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-weight:600;font-size:13px;flex-wrap:wrap}
.syh-msg{font-size:12px;margin-left:8px;color:var(--dsw-alias-state-success-primary)}
.syh-msgerr{color:var(--dsw-alias-state-error-primary)}
.syh-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px}
.syh-bar > i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.syh-bar.warn > i{background:var(--dsw-alias-state-warn-primary)}
.syh-bar.bad > i{background:var(--dsw-alias-state-error-primary)}
.syh-ws{display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.syh-ws:last-child{border-bottom:0}
.syh-ws-path{font-size:13px;font-weight:600;word-break:break-all}
.syh-ws-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.syh-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.syh-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.syh-chip.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.syh-search{width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;margin-bottom:10px}
.syh-savebar{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-base);padding:10px 0 2px;margin-top:4px}
.syh-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.syh-capsule{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:3px 10px 3px 12px;font-size:12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary)}
.syh-capsule input{position:absolute;opacity:0;width:0;height:0}
.syh-capsule i{position:relative;width:26px;height:14px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);display:inline-block;transition:background .15s}
.syh-capsule i::after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.syh-capsule input:checked ~ i{background:var(--dsw-alias-brand-primary)}
.syh-capsule input:checked ~ i::after{transform:translateX(12px);background:#fff}
.syh-capsule input:checked ~ span{color:var(--dsw-alias-brand-primary)}
.syh-capsule:has(input:checked){border-color:var(--dsw-alias-brand-primary)}
`

    function Badge({ status, t }) {
      return h('span', { className: `syh-badge syh-${status}` }, t(status) || status)
    }

    function StatCard({ label, value, onClick }) {
      return h('button', { className: 'syh-stat', onClick, type: 'button' }, h('b', null, String(value ?? 0)), h('span', null, label))
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

    // 会话输入区权限右侧的「超级智能体」胶囊：点亮即把本会话登记为该工作区唯一的单会话。
    const PILL_CSS = `
.sysp{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;user-select:none;white-space:nowrap}
.sysp:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.sysp:disabled{cursor:default;opacity:.85}
.sysp.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.sysp i{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
`

    function SingleSessionPill(props) {
      const t = useT(props.ctx)
      const sessionId = props.sessionId
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const load = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const response = await fetch(`${BASE}/single?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
          if (!response.ok) return
          setState(await response.json())
        } catch {
          /* 状态拿不到就不显示胶囊 */
        }
      }, [sessionId])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])
      const turnOn = async () => {
        setBusy(true)
        try {
          await post('/action', { action: 'register-single', sessionId })
          await load()
        } catch (error) {
          if (typeof window !== 'undefined' && window.alert) window.alert(String(error?.message || error))
        } finally {
          setBusy(false)
        }
      }
      if (!state?.ok || state.enabled !== true) return null
      if (!state.registered && state.workspaceOccupied) return null
      if (!state.registered && !state.workspaceId) return null
      const on = state.registered === true
      return h('button', {
        type: 'button',
        className: `sysp ${on ? 'on' : ''}`,
        disabled: on || busy,
        title: on ? t('pillOnTip') : t('pillTip'),
        onClick: on ? undefined : turnOn,
      }, h('style', null, PILL_CSS), h('i', null), t('pill'))
    }

    function PressureBar({ ratio }) {
      const level = ratio >= 0.85 ? 'bad' : ratio >= 0.5 ? 'warn' : ''
      return h('div', { className: `syh-bar ${level}` }, h('i', { style: { width: `${Math.min(100, Math.round(ratio * 100))}%` } }))
    }

    // 会话内任务板：像智能体团队一样，在会话头看到这个单会话的工单进度。
    const BOARD_CSS = `
.syhb{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;margin:6px 0;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.syhb h4{margin:0 0 6px;font-size:12px;font-weight:600;display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-primary)}
.syhb .syhb-muted{color:var(--dsw-alias-label-secondary);font-weight:400}
.syhb-row{display:flex;gap:6px;align-items:center;padding:3px 0;color:var(--dsw-alias-label-primary)}
.syhb-row:hover{background:var(--dsw-alias-bg-layer-2)}
.syhb-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}
.syhb-dot.running{background:var(--dsw-alias-brand-primary)}
.syhb-dot.queued,.syhb-dot.waiting{background:var(--dsw-alias-state-warn-primary)}
.syhb-dot.done{background:var(--dsw-alias-state-success-primary)}
.syhb-dot.failed{background:var(--dsw-alias-state-error-primary)}
.syhb-subject{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    function SessionBoard(props) {
      const t = useT(props.ctx)
      const sessionId = props.sessionId
      const [tickets, setTickets] = React.useState([])
      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(`${BASE}/status?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
            if (!response.ok) return
            const data = await response.json()
            if (alive) setTickets(Array.isArray(data.tickets) ? data.tickets : [])
          } catch {
            /* 控制台不可用时任务板静默 */
          }
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      const visible = tickets.slice(-8).reverse()
      if (visible.length === 0) return null
      const running = tickets.filter((item) => item.status === 'running').length
      const pending = tickets.filter((item) => item.status === 'queued').length
      return h('section', { className: 'syhb', 'data-superagent-board': '' },
        h('style', null, BOARD_CSS),
        h('h4', null, t('boardTitle'),
          h('span', { className: 'syhb-muted' }, [
            running > 0 ? t('boardRunning', { count: running }) : null,
            pending > 0 ? t('boardPending', { count: pending }) : null,
            t('boardTotal', { count: tickets.length }),
          ].filter(Boolean).join(' · ')),
        ),
        visible.map((ticket) => h('div', {
          key: ticket.id,
          className: 'syhb-row',
          title: ticket.summary || ticket.lastError || ticket.title || ticket.id,
          onClick: () => { try { props.ctx.layout.selectPanel(PANEL_ID) } catch { /* 忽略 */ } },
          style: { cursor: 'pointer' },
        },
          h('i', { className: `syhb-dot ${ticket.status}` }),
          h('span', { className: 'syhb-subject' }, ticket.title || ticket.id),
          h('span', { className: 'syhb-muted' }, t(ticket.status) || ticket.status),
        )),
      )
    }

    function Console({ ctx, compact = false, onClose }) {
      const t = useT(ctx)
      const { data, error: loadError, reload } = useStatus(ctx)
      const [tab, setTab] = React.useState('overview')
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [error, setError] = React.useState('')
      const [log, setLog] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [busySession, setBusySession] = React.useState('')
      const [singleBusy, setSingleBusy] = React.useState(false)

      const toggleSingle = async (next) => {
        setSingleBusy(true)
        setError('')
        try {
          await post('/settings', { singleSession: { enabled: next } })
          setMsg(next ? t('capsuleOn') : t('capsuleOff'))
          await reload()
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setSingleBusy(false)
        }
      }

      React.useEffect(() => {
        if (data?.config && form === null) setForm(buildForm(data.config, data.config.singleSession))
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
        setMsg(t('unsaved'))
      }

      const run = async (fn, okMessage) => {
        setMsg('')
        setError('')
        try {
          await fn()
          if (okMessage) setMsg(okMessage)
          await reload()
        } catch (reason) {
          setMsg('')
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

      const compactNow = (sessionId) => run(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('confirmCompact'))) return
        setBusySession(sessionId)
        setMsg(t('compacting'))
        try {
          const result = await post('/action', { action: 'compact', sessionId })
          setMsg(result?.skipped ? t('compactSkip') : t('compactOk'))
        } finally {
          setBusySession('')
        }
      })

      const deleteSingle = (sessionId) => run(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('deleteSingleConfirm'))) return
        setBusySession(sessionId)
        try {
          await post('/action', { action: 'delete-single', sessionId })
          setMsg(t('deleteSingleDone'))
        } finally {
          setBusySession('')
        }
      })

      const openSession = (sessionId) => {
        const workspace = services.workspace
        if (!workspace?.openSession) { setError(t('noHostService')); return }
        try { workspace.openSession(sessionId) } catch (reason) { setError(String(reason?.message || reason)) }
      }

      const showLog = (ticket) => run(async () => {
        const response = await fetch(`${BASE}/log?ticketId=${encodeURIComponent(ticket.id)}`, { cache: 'no-store' })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
        setLog({ id: ticket.id, text: body.text, truncated: body.truncated })
      })

      const openRight = () => {
        const right = services.right
        if (!right?.openTab) { setError(t('noHostService')); return }
        try { right.openTab(NS) } catch (reason) { setError(String(reason?.message || reason)) }
      }

      const stats = data?.stats ?? { queued: 0, running: 0, waiting: 0, done: 0, failed: 0 }
      const tickets = [...(data?.tickets ?? [])].reverse()
      const visibleTabs = compact ? ['overview', 'tickets'] : TABS

      const header = h('div', { className: 'syh-head' },
        h('div', { className: 'syh-grow' },
          h('h1', null, t('title')),
          h('div', { className: 'syh-sub' }, t('subtitle')),
        ),
        h('span', { className: 'syh-live' },
          h('i', { className: `syh-dot ${data?.dryRun ? 'dry' : ''}` }),
          `v${data?.config?.version || '?'} · ${data?.dryRun ? 'dryRun' : 'live'}`,
        ),
        h('label', { className: 'syh-capsule', title: t('singleHint') },
          h('input', {
            type: 'checkbox',
            checked: data?.singleSession?.enabled === true,
            disabled: singleBusy,
            onChange: (event) => toggleSingle(event.target.checked),
          }),
          h('span', null, t('capsule')),
          h('i', null),
        ),
        h('button', { className: 'syh-btn', onClick: () => reload() }, t('refresh')),
        compact
          ? h('button', { className: 'syh-btn syh-btn-primary', onClick: () => ctx.layout.selectPanel(PANEL_ID) }, t('openConsole'))
          : h('button', { className: 'syh-btn', onClick: openRight }, t('openRight')),
        h('button', { className: 'syh-btn', onClick: () => onClose?.() }, t('close')),
      )

      const statsRow = h('div', { className: 'syh-stats' },
        ['queued', 'running', 'waiting', 'done', 'failed'].map((key) => h(StatCard, {
          key,
          label: t(key),
          value: stats[key],
          onClick: () => { setFilter(key); setTab('tickets') },
        })),
      )

      const errorBox = (loadError || error) ? h('div', { className: 'syh-card' },
        loadError ? h('div', { className: 'syh-err' }, t('loadFailed') + '：' + loadError) : null,
        error ? h('div', { className: 'syh-err' }, error) : null,
      ) : null

      const sourceHealth = data?.sources ?? {}
      const enabledSources = data?.config?.sources ? Object.entries(data.config.sources).filter(([, value]) => value.enabled).map(([key]) => key) : []

      function overview() {
        return h('div', null,
          statsRow,
          h('div', { className: 'syh-card' },
            h('h2', null, t('workspace'), h('span', { className: 'syh-muted' }, ` (${data?.singleSession?.workspaces?.length ?? 0})`)),
            !data?.singleSession?.enabled
              ? h('div', { className: 'syh-empty' }, t('noWorkspace'))
              : (data.singleSession.workspaces ?? []).length === 0
                ? h('div', { className: 'syh-empty' }, t('noWorkspace'))
                : data.singleSession.workspaces.map((workspace) => h('div', { className: 'syh-ws', key: workspace.sessionId || workspace.path },
                    h('div', null,
                      h('div', { className: 'syh-ws-path', title: workspace.path }, workspace.path),
                      h('div', { className: 'syh-ws-meta' },
                        workspace.missing
                          ? t('wsMissing')
                          : `${workspace.sessionId} · ${t('wsLastCompact')}: ${workspace.lastCompact ? new Date(workspace.lastCompact.at).toLocaleString() : t('wsNever')}`,
                      ),
                      workspace.missing ? null : h('div', { style: { marginTop: 6, minWidth: 220 } },
                        h('div', { className: 'syh-ws-meta' }, `${t('wsPressure')}: ${workspace.pressureTokens}/${workspace.contextWindow || '?'} (${Math.round((workspace.ratio || 0) * 100)}%)`),
                        h(PressureBar, { ratio: workspace.ratio || 0 }),
                      ),
                    ),
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h('span', { className: `syh-badge syh-${workspace.running ? 'running' : workspace.status === 'missing' ? 'failed' : 'done'}` }, workspace.running ? t('wsRunning') : (workspace.status || 'idle')),
                      workspace.sessionId ? h('button', { className: 'syh-btn', onClick: () => openSession(workspace.sessionId) }, t('session')) : null,
                      workspace.sessionId ? h('button', { className: 'syh-btn', disabled: busySession === workspace.sessionId, onClick: () => compactNow(workspace.sessionId) }, busySession === workspace.sessionId ? t('compacting') : t('compactNow')) : null,
                      workspace.sessionId ? h('button', { className: 'syh-btn syh-btn-danger', disabled: busySession === workspace.sessionId, onClick: () => deleteSingle(workspace.sessionId) }, t('deleteSingle')) : null,
                    ),
                  )),
          ),
          h('div', { className: 'syh-card' },
            h('h2', null, t('sourceHealth')),
            enabledSources.length === 0
              ? h('div', { className: 'syh-empty' }, t('noSources'))
              : enabledSources.map((key) => {
                  const health = sourceHealth[key] ?? {}
                  return h('div', { key, className: 'syh-ws' },
                    h('div', null,
                      h('div', { className: 'syh-ws-path' }, key),
                      h('div', { className: 'syh-ws-meta' }, `${t('watermark')}: ${health.watermark ? new Date(health.watermark).toLocaleString() : '—'} · ${t('added')}: ${health.added ?? 0}`),
                    ),
                    h('span', { className: `syh-badge ${health.ok === undefined ? '' : health.ok ? 'syh-done' : 'syh-failed'}` }, health.ok === undefined ? '—' : health.ok ? t('stateOk') : t('stateFail')),
                  )
                }),
            data?.lastError ? h('div', { className: 'syh-err', style: { marginTop: 8 } }, data.lastError) : null,
          ),
          h('div', { className: 'syh-card' },
            h('h2', null, t('recent')),
            tickets.length === 0
              ? h('div', { className: 'syh-empty' }, t('noTickets'))
              : tickets.slice(0, 10).map((ticket) => h('div', { key: ticket.id, className: 'syh-ws' },
                  h('div', null,
                    h('div', { className: 'syh-ws-path', style: { fontSize: 12, fontWeight: 500 } }, ticket.title || ticket.id),
                    h('div', { className: 'syh-ws-meta' }, `${ticket.id} · ${new Date(ticket.createdAt || Date.now()).toLocaleString()}`),
                  ),
                  h(Badge, { status: ticket.status, t }),
                )),
          ),
        )
      }

      function matchFilter(ticket) {
        if (filter !== 'all' && ticket.status !== filter) return false
        if (!query.trim()) return true
        const needle = query.trim().toLowerCase()
        return ticket.id.toLowerCase().includes(needle) || String(ticket.title || '').toLowerCase().includes(needle)
      }

      function ticketsView() {
        const list = tickets.filter(matchFilter)
        return h('div', null,
          h('div', { className: 'syh-chips' },
            ['all', 'queued', 'running', 'waiting', 'done', 'failed'].map((key) => h('button', {
              key,
              className: `syh-chip ${filter === key ? 'active' : ''}`,
              onClick: () => setFilter(key),
            }, key === 'all' ? t('all') : t(key))),
          ),
          h('input', { className: 'syh-search', value: query, placeholder: t('search'), onChange: (event) => setQuery(event.target.value) }),
          h('div', { className: 'syh-card' },
            list.length === 0
              ? h('div', { className: 'syh-empty' }, query ? t('noMatch') : t('noTickets'))
              : h('table', { className: 'syh-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('tickets')),
                    h('th', null, t('source')),
                    h('th', null, t('status')),
                    h('th', null, t('attempts')),
                    h('th', null, t('lastError')),
                    h('th', null, t('actions')),
                  )),
                  h('tbody', null, list.map((ticket) => h('tr', { key: ticket.id },
                    h('td', null,
                      h('code', { style: { fontSize: 11 } }, ticket.id),
                      h('div', { style: { fontSize: 12 } }, ticket.title || ''),
                      ticket.question ? h('div', { className: 'syh-err', style: { fontSize: 11 } }, '？' + ticket.question) : null,
                    ),
                    h('td', null, h('span', { className: 'syh-muted' }, ticket.source)),
                    h('td', null, h(Badge, { status: ticket.status, t })),
                    h('td', null, String(ticket.attempts ?? 0)),
                    h('td', null, ticket.lastError ? h('div', { className: 'syh-err' }, ticket.lastError) : h('span', { className: 'syh-muted' }, '—')),
                    h('td', null,
                      h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                        ticket.status === 'failed' ? h('button', { className: 'syh-btn', onClick: () => act(ticket, 'retry') }, t('retry')) : null,
                        (ticket.status === 'running' || ticket.status === 'waiting') ? h('button', { className: 'syh-btn syh-btn-danger', onClick: () => act(ticket, 'cancel') }, t('cancel')) : null,
                        ticket.sessionId ? h('button', { className: 'syh-btn', onClick: () => openSession(ticket.sessionId) }, t('session')) : null,
                        h('button', { className: 'syh-btn', onClick: () => showLog(ticket) }, t('log')),
                      ),
                    ),
                  ))),
                ),
            log ? h('div', null,
              h('div', { className: 'syh-row', style: { marginTop: 10 } },
                h('strong', { style: { fontSize: 12 } }, log.id),
                h('button', { className: 'syh-btn', onClick: () => setLog(null) }, t('closeLog')),
              ),
              h('pre', { className: 'syh-pre' }, (log.truncated ? '…（只显示最后 200 行）\n' : '') + log.text),
            ) : null,
          ),
        )
      }

      function sourceCard(title, section, fields, extra) {
        return h('div', { className: 'syh-src' },
          h('div', { className: 'syh-src-head' }, title,
            h(Check, { label: t('enabled'), checked: section.enabled, onChange: (v) => setField(`${section.key}.enabled`, v) }),
            h(Check, { label: t('confirmWrites'), checked: section.confirmWrites, onChange: (v) => setField(`${section.key}.confirmWrites`, v) }),
          ),
          h('div', { className: 'syh-row' },
            fields.map(([key, label]) => h(Field, { key, label }, h(TextInput, { value: section[key], onChange: (v) => setField(`${section.key}.${key}`, v) }))),
          ),
          extra ?? null,
        )
      }

      function sourcesView() {
        if (!form) return h('div', { className: 'syh-empty' }, t('loadFailed'))
        return h('div', { className: 'syh-card' },
          h('h2', null, t('sourcesTab')),
          sourceCard(t('github'), { ...form.github, key: 'github' }, [
            ['repo', t('repo')], ['labels', t('labels')], ['authors', t('authors')], ['apiBase', t('apiBase')],
          ], h('div', { className: 'syh-row' },
            h(Field, { label: t('token') }, h(TextInput, { type: 'password', value: form.github.token, placeholder: form.github.hasToken ? t('tokenSet') : t('tokenUnset'), onChange: (v) => setField('github.token', v) })),
          )),
          sourceCard(t('feishu'), { ...form.feishu, key: 'feishu' }, [
            ['appId', t('appId')], ['chatIds', t('chatIds')], ['authors', t('authors')],
          ], h('div', { className: 'syh-row' },
            h(Field, { label: t('appSecret') }, h(TextInput, { type: 'password', value: form.feishu.appSecret, placeholder: form.feishu.hasSecret ? t('tokenSet') : t('tokenUnset'), onChange: (v) => setField('feishu.appSecret', v) })),
            h(Check, { label: t('requireMention'), checked: form.feishu.requireMention, onChange: (v) => setField('feishu.requireMention', v) }),
          )),
          h('div', { className: 'syh-src' },
            h('div', { className: 'syh-src-head' }, t('qq'),
              h(Check, { label: t('enabled'), checked: form.qq.enabled, onChange: (v) => setField('qq.enabled', v) }),
              h(Field, { label: t('mode') }, h('select', { value: form.qq.mode, onChange: (e) => setField('qq.mode', e.target.value) },
                h('option', { value: 'personal' }, t('personal')),
                h('option', { value: 'official' }, t('official')),
              )),
              h(Check, { label: t('requireAt'), checked: form.qq.requireAt, onChange: (v) => setField('qq.requireAt', v) }),
              h(Check, { label: t('confirmWrites'), checked: form.qq.confirmWrites, onChange: (v) => setField('qq.confirmWrites', v) }),
            ),
            h('div', { className: 'syh-row' },
              h(Field, { label: t('qqSenders') }, h(TextInput, { value: form.qq.authors, onChange: (v) => setField('qq.authors', v) })),
              h(Field, { label: t('qqTargets') }, h(TextInput, { value: form.qq.allowedGroups, onChange: (v) => setField('qq.allowedGroups', v) })),
            ),
            form.qq.mode === 'personal'
              ? h('div', { className: 'syh-row' },
                  h(Field, { label: t('httpUrl') }, h(TextInput, { value: form.qq.personal.httpUrl, onChange: (v) => setField('qq.personal.httpUrl', v) })),
                  h(Field, { label: t('wsUrl') }, h(TextInput, { value: form.qq.personal.wsUrl, onChange: (v) => setField('qq.personal.wsUrl', v) })),
                  h(Field, { label: t('selfId') }, h(TextInput, { value: form.qq.personal.selfId, onChange: (v) => setField('qq.personal.selfId', v) })),
                )
              : h('div', { className: 'syh-row' },
                  h(Field, { label: t('host') }, h(TextInput, { value: form.qq.official.host, onChange: (v) => setField('qq.official.host', v) })),
                  h(Field, { label: t('port') }, h(TextInput, { type: 'number', value: form.qq.official.port, onChange: (v) => setField('qq.official.port', v) })),
                  h(Field, { label: t('token') }, h(TextInput, { type: 'password', value: form.qq.official.token, placeholder: form.qq.official.hasToken ? t('tokenSet') : t('tokenUnset'), onChange: (v) => setField('qq.official.token', v) })),
                ),
          ),
          saveBar(),
        )
      }

      function settingsView() {
        if (!form) return h('div', { className: 'syh-empty' }, t('loadFailed'))
        const s = form.single
        return h('div', null,
          h('div', { className: 'syh-card' },
            h('h2', null, t('basic')),
            h('div', { className: 'syh-row' },
              h(Check, { label: t('dryRun'), checked: form.dryRun, onChange: (v) => setField('dryRun', v) }),
              h(Field, { label: t('mainSession') }, h(TextInput, { value: form.mainSessionId, onChange: (v) => setField('mainSessionId', v) })),
              h(Field, { label: t('repoPath') }, h(TextInput, { value: form.repoPath, onChange: (v) => setField('repoPath', v) })),
              h(Field, { label: t('poll') }, h(TextInput, { type: 'number', value: form.pollIntervalMs, onChange: (v) => setField('pollIntervalMs', v) })),
              h(Field, { label: t('preset') }, h(TextInput, { value: form.workerPreset, onChange: (v) => setField('workerPreset', v) })),
            ),
          ),
          h('div', { className: 'syh-card' },
            h('h2', null, t('singleTitle')),
            h('div', { className: 'syh-muted', style: { fontSize: 12, marginBottom: 10 } }, t('singleHint')),
            h('div', { className: 'syh-row' },
              h(Check, { label: t('singleEnabled'), checked: s.enabled, onChange: (v) => setField('single.enabled', v) }),
              h(Check, { label: t('autoCreate'), checked: s.autoCreate, onChange: (v) => setField('single.autoCreate', v) }),
              h(Check, { label: t('aggressive'), checked: s.aggressive, onChange: (v) => setField('single.aggressive', v) }),
            ),
            h('div', { className: 'syh-row' },
              h(Field, { label: t('idleMinutes') }, h(TextInput, { type: 'number', value: s.idleMinutes, onChange: (v) => setField('single.idleMinutes', v) })),
              h(Field, { label: t('pressureRatio') }, h(TextInput, { type: 'number', value: s.pressureRatio, onChange: (v) => setField('single.pressureRatio', v) })),
              h(Field, { label: t('keepRecentTurns') }, h(TextInput, { type: 'number', value: s.keepRecentTurns, onChange: (v) => setField('single.keepRecentTurns', v) })),
              h(Field, { label: t('sessionIdPrefix') }, h(TextInput, { value: s.sessionIdPrefix, onChange: (v) => setField('single.sessionIdPrefix', v) })),
            ),
          ),
          saveBar(),
        )
      }

      function saveBar() {
        return h('div', { className: 'syh-savebar' },
          h('button', { className: 'syh-btn syh-btn-primary', onClick: save, disabled: !form }, t('save')),
          msg ? h('span', { className: `syh-msg ${error ? 'syh-msgerr' : ''}` }, msg) : null,
          error ? h('span', { className: 'syh-msg syh-msgerr' }, error) : null,
        )
      }

      const body = tab === 'overview' ? overview() : tab === 'tickets' ? ticketsView() : tab === 'sources' ? sourcesView() : settingsView()

      return h('div', { className: `syh-root ${compact ? 'syh-compact' : ''}` },
        h('style', null, CSS),
        h('div', { className: compact ? '' : 'syh-wrap' },
          header,
          errorBox,
          h('div', { className: 'syh-tabs' }, visibleTabs.map((key) => h('button', {
            key,
            className: `syh-tab ${tab === key ? 'active' : ''}`,
            onClick: () => setTab(key),
          }, t(key === 'tickets' ? 'ticketsTab' : key === 'sources' ? 'sourcesTab' : key === 'settings' ? 'settingsTab' : 'overview')))),
          body,
          compact ? h('div', { className: 'syh-muted', style: { fontSize: 11, marginTop: 8 } }, t('closeHint')) : null,
        ),
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
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }))

        ctx.inject(['uiWorkspace'], (child) => {
          services.workspace = child.get('uiWorkspace') ?? child.uiWorkspace ?? null
        })

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

        // 会话内任务板：挂在会话头 subagent 区（和智能体团队同区，组件独立）。
        ctx.slots.inject('conversation.session.header.actions.subagent.footer', () => ctx.slots.register({
          name: 'conversation.session.header.actions.subagent.footer',
          id: NS,
          locale: NS,
          inject: () => ({ ctx }),
        }, SessionBoard))

        // 会话输入区（权限右侧）的「超级智能体」胶囊：登记本工作区唯一的单会话。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: NS,
          locale: NS,
          inject: () => ({ ctx }),
        }, SingleSessionPill))

        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (child) => {
          const tabs = child.get('sidebarRightTabs') ?? child.sidebarRightTabs
          services.right = child.get('sidebarRight') ?? child.sidebarRight ?? null
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
