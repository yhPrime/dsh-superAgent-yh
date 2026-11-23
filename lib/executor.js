/**
 * 执行器：为工单开独立 worktree + 独立 worker 会话（worker-<id>），投递 mandate，
 * 用 ticket_report 工具收回报，然后按需要人 / 完成 / 失败走 relay。
 * 串行：调度器一次只放一个工单进来。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { markDone, markFailed, markRunning, markWaiting, safeSessionId } from './ticket.js'
import { textFor } from './relay.js'

const REPORT_TOOL = 'ticket_report'

function mandate(ticket, workdir) {
  return [
    '你是 dsh-superAgent-yh 的执行器（worker）。一个工单只做这一件事，做完必须回报。',
    '',
    `工单：${ticket.id}`,
    `来源：${ticket.source} ${ticket.thread}`,
    `标题：${ticket.title}`,
    `正文：${ticket.body || '（无正文）'}`,
    `原始链接：${ticket.url || '（无）'}`,
    `工作目录：${workdir}（独立 git worktree，只在这里改动）`,
    '',
    '要求：',
    '1. 先读代码/资料再动手；改动保持最小，不做工单以外的重构。',
    '2. 改完运行必要检查（测试/构建），确认能过。',
    `3. 结束时必须调用 ${REPORT_TOOL} 工具：完成用 status=done + summary（≤300字，可带 link）；需要人决策用 status=waiting + question；做不了用 status=failed + summary 写原因。`,
    '4. 不要改工作目录以外的文件；不要评论/推送/开 PR，除非工单明确要求。',
  ].join('\n')
}

export function createExecutor({ ctx, config, store, relay, redact, log, sources = {} }) {
  const controller = new AbortController()
  const disposers = new Map()
  let busy = false

  function workdirOf(ticket) {
    const safe = safeSessionId(ticket.id).replace(/^worker-/, '')
    return join(config.workRoot, safe)
  }

  function ensureWorktree(ticket) {
    const dir = ticket.workdir || workdirOf(ticket)
    mkdirSync(config.workRoot, { recursive: true })
    if (existsSync(join(dir, '.git'))) return dir
    if (!config.repoPath) {
      mkdirSync(dir, { recursive: true })
      return dir
    }
    const branch = `superagent/${safeSessionId(ticket.id).replace(/^worker-/, '')}`
    try {
      execFileSync('git', ['-C', config.repoPath, 'worktree', 'add', '-B', branch, dir, config.baseRef], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      })
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr).trim() : String(error)
      throw new Error(redact(`git worktree add 失败：${stderr}`))
    }
    return dir
  }

  async function ensureSession(ticket, workdir) {
    // 宿主启动早期 preset 可能还没注册完；先确认，避免建出没有 loop 的会话。
    if (ctx.agentPresets) {
      try {
        await ctx.agentPresets.resolve(config.workerPreset)
      } catch (error) {
        throw new Error(`worker preset "${config.workerPreset}" 未注册：${error.message}`)
      }
    }
    let sessionId = ticket.sessionId || safeSessionId(ticket.id)
    let result = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) {
      if (result.error.code !== 'session/not-found') throw new Error(`会话不可用：${result.error.code}`)
      const created = await ctx.sessionController.create({ sessionId, cwd: workdir, agentPreset: config.workerPreset })
      log(ticket.id, `session created ${JSON.stringify(created)}`)
      // 宿主可能返回不同的实际会话 id（例如请求的 id 不可复用）；以返回值为准。
      if (created?.sessionId && created.sessionId !== sessionId) {
        log(ticket.id, `requested session ${sessionId}, host returned ${created.sessionId}`)
        sessionId = created.sessionId
        ticket.sessionId = sessionId
        store.save()
      }
      result = await ctx.sessionController.resolveAgent(sessionId)
    }
    if ('error' in result) throw new Error(`会话创建后不可用：${result.error.code}`)
    return { sessionId, agent: result.agent }
  }

  /** 回写到来源会话（QQ/飞书可回；GitHub 默认 confirmWrites=false 会跳过）。 */
  async function notifySource(ticket, kind) {
    const source = sources[ticket.source]
    if (!source || typeof source.send !== 'function' || config.dryRun) return
    try {
      const receipt = await source.send(ticket.thread, textFor(ticket, kind), {
        requestId: `notify:${ticket.id}:${kind}`,
        receivedAt: Date.parse(ticket.at),
      })
      log(ticket.id, `source notify ${kind} ok${receipt ? ` ${JSON.stringify(receipt).slice(0, 120)}` : ''}`)
    } catch (error) {
      log(ticket.id, `source notify ${kind} skipped: ${error.message}`)
    }
  }

  function registerReportTool(agent, ticket) {
    const definition = {
      name: REPORT_TOOL,
      description: '回报当前工单的结果。完成/需要人/失败都必须调用一次。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['done', 'waiting', 'failed'], description: 'done=完成；waiting=需要人决策；failed=做不了' },
          summary: { type: 'string', description: '一句话结果或失败原因（≤300字）' },
          question: { type: 'string', description: 'status=waiting 时的人话问题（≤200字）' },
          link: { type: 'string', description: '完成时的链接（PR/提交/文件，可选）' },
        },
        required: ['status', 'summary'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, status: { type: 'string' } },
          required: ['ok', 'status'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const current = store.state.tickets[ticket.id]
        if (!current) throw new Error(`工单不存在：${ticket.id}`)
        if (current.status !== 'running' && current.status !== 'waiting') {
          throw new Error(`工单 ${ticket.id} 当前状态 ${current.status}，不能回报`)
        }
        const summary = redact(String(args.summary ?? '').slice(0, 300))
        const question = redact(String(args.question ?? '').slice(0, 200))
        const link = String(args.link ?? '').slice(0, 500)
        const report = { at: Date.now(), summary, question, link }
        if (args.status === 'done') markDone(current, report)
        else if (args.status === 'waiting') markWaiting(current, report)
        else if (args.status === 'failed') {
          current.lastError = summary || 'worker 报告失败'
          markFailed(current, summary || 'worker 报告失败')
        }
        store.save()
        log(ticket.id, `report ${args.status}: ${summary}`)
        // 回报即发主线消息（不等轮次结束）；失败不阻塞工具返回。
        if (args.status === 'done') relay.send(current, 'done').catch(() => {})
        if (args.status === 'waiting') relay.send(current, 'needHuman').catch(() => {})
        if (args.status === 'failed') relay.send(current, 'failed').catch(() => {})
        notifySource(current, args.status === 'waiting' ? 'needHuman' : args.status).catch(() => {})
        return { ok: true, status: args.status }
      },
    }
    const disposer = agent.ctx.tools.register(definition)
    return disposer
  }

  function releaseTool(sessionId) {
    const dispose = disposers.get(sessionId)
    if (!dispose) return
    try {
      dispose()
    } catch {
      /* agent 已销毁 */
    }
    disposers.delete(sessionId)
  }

  async function runTicket(ticketId) {
    if (busy) return { skipped: 'busy' }
    busy = true
    const ticket = store.state.tickets[ticketId]
    try {
      if (!ticket) throw new Error(`工单不存在：${ticketId}`)
      if (ticket.dryRun) return { skipped: 'dryRun' }

      const workdir = ensureWorktree(ticket)
      const branch = config.repoPath ? `superagent/${safeSessionId(ticket.id).replace(/^worker-/, '')}` : null
      markRunning(ticket, { workdir, branch, sessionId: safeSessionId(ticket.id), relayed: ticket.relayed })
      store.save()
      log(ticket.id, `start worker session ${ticket.sessionId} @ ${workdir}`)
      await relay.send(ticket, 'started').catch((error) => log(ticket.id, `relay started failed: ${error.message}`))

      const { sessionId, agent } = await ensureSession(ticket, workdir)
      ticket.sessionId = sessionId
      store.save()

      try {
        ctx.permissionPresets.set(agent.session, 'danger-full-access')
      } catch (error) {
        log(ticket.id, `permission preset failed: ${error.message}`)
      }

      if (!disposers.has(sessionId)) {
        const dispose = registerReportTool(agent, ticket)
        disposers.set(sessionId, dispose)
      }

      let waited = null
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await ctx.sessionController.prompt(
          {
            requestId: `mandate:${ticket.id}:${ticket.attempts}:${attempt}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: mandate(ticket, workdir) }],
          },
          controller.signal,
        )
        waited = await ctx.sessionController.wait(
          { sessionId, timeoutMs: config.workerTimeoutMs, maxMessages: 50 },
          controller.signal,
        )
        const after = store.state.tickets[ticket.id]
        if (after.status !== 'running') break
        // 宿主刚启动时 agent 可能还没真正开跑：本轮没有任何 assistant 消息就重投一次。
        const hasAssistant = (waited.output?.records ?? []).some((record) => record?.event?.type === 'assistant/message')
        if (hasAssistant || waited.reason === 'timeout' || waited.reason === 'input-required') break
        log(ticket.id, `worker 未启动（wait=${waited.reason}），重投 mandate（第 ${attempt + 1} 次）`)
      }

      const current = store.state.tickets[ticket.id]
      if (current === undefined) throw new Error(`工单消失：${ticket.id}`)
      if (current.status === 'done' || current.status === 'waiting') {
        log(ticket.id, `finished ${current.status} (wait=${waited?.reason})`)
        if (current.status === 'done') releaseTool(sessionId)
        return { status: current.status }
      }
      if (current.status === 'failed') {
        log(ticket.id, 'worker reported failed')
        releaseTool(sessionId)
        return { status: 'failed' }
      }

      // worker 没有回报：按原因落失败，并把仍在跑的轮次取消。
      const reason = waited?.reason === 'timeout'
        ? `worker 超时（${Math.round(config.workerTimeoutMs / 1000)}s）未回报`
        : waited?.reason === 'input-required'
          ? 'worker 在等人输入（未调用 ticket_report）'
          : 'worker 结束本轮但未调用 ticket_report'
      markFailed(current, reason)
      store.save()
      log(ticket.id, `failed: ${reason}`)
      try {
        ctx.sessionController.cancel({ sessionId })
      } catch {
        /* 已空闲 */
      }
      await relay.send(current, 'failed').catch(() => {})
      await notifySource(current, 'failed')
      return { status: 'failed' }
    } catch (error) {
      const current = store.state.tickets[ticketId]
      const message = redact(error && error.message ? error.message : String(error))
      if (current && current.status !== 'done' && current.status !== 'failed') {
        try {
          markFailed(current, message)
          store.save()
          await relay.send(current, 'failed').catch(() => {})
          await notifySource(current, 'failed')
        } catch (inner) {
          log(ticketId, `mark failed error: ${inner.message}`)
        }
      }
      log(ticketId, `error: ${message}`)
      return { status: 'failed', error: message }
    } finally {
      busy = false
    }
  }

  return {
    busy: () => busy,
    runTicket,
    dispose() {
      controller.abort()
      for (const [, dispose] of disposers) {
        try {
          dispose()
        } catch {
          /* 已随 agent 销毁 */
        }
      }
      disposers.clear()
    },
  }
}

export function createFileLogger(store, redact) {
  return (ticketId, message) => {
    try {
      const line = `${new Date().toISOString()} ${redact(message)}\n`
      appendFileSync(join(store.logsDir, `${String(ticketId).replace(/[^A-Za-z0-9._-]+/g, '-')}.log`), line, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}
