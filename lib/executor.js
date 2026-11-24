/**
 * 执行器（统一三层管线）：assessment → resolveTarget → orchestrator.route → spawnWorker → teardown。
 * 单会话开启：worker 是目标单会话里的子智能体（子智能体会话 + 独立 worktree），完工即卸载。
 * 单会话关闭：回退旧的顶层 worker-<id> 会话路径（对照/排障用）。
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
    `3. 结束时调用 ${REPORT_TOOL} 工具；拿不到工具就在最后一行输出 JSON：{"status":"done|waiting|failed","summary":"…","question":"…","link":"…"}`,
    '4. 不要改工作目录以外的文件；不要评论/推送/开 PR，除非工单明确要求。',
  ].join('\n')
}

const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')

/** 从子智能体最终输出里解析回报；解析不出按 stopReason 兜底。 */
export function parseReport(output, stopReason) {
  const text = textOf(output)
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1))
      if (value && ['done', 'waiting', 'failed'].includes(value.status)) {
        return {
          status: value.status,
          summary: String(value.summary ?? '').slice(0, 300),
          question: String(value.question ?? '').slice(0, 200),
          link: String(value.link ?? '').slice(0, 500),
        }
      }
    } catch {
      /* 落到兜底 */
    }
  }
  const tail = text.trim().slice(-300)
  if (stopReason === undefined || stopReason === 'completed') {
    return { status: 'done', summary: tail || '已完成（未附摘要）' }
  }
  return { status: 'failed', summary: tail || `子智能体结束原因：${stopReason}` }
}

export function createExecutor({ ctx, config, store, relay, redact, log, sources = {}, assessment, targetResolver, orchestrator, getSubagents = () => null, archiveSession }) {
  const controller = new AbortController()
  const disposers = new Map()
  let busy = false

  function workdirOf(ticket) {
    const safe = safeSessionId(ticket.id).replace(/^worker-/, '')
    return join(config.workRoot, safe)
  }

  /** 清理占用同名分支的旧 worktree（换 stateDir/重跑时常见），避免 add 失败。 */
  function clearStaleWorktree(repoPath, branch, dir) {
    try {
      const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 30_000 })
      const blocks = out.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const matchPath = block.match(/^worktree (.+)$/m)
        const matchBranch = block.match(/^branch refs\/heads\/(.+)$/m)
        if (!matchPath) continue
        const path = matchPath[1].trim()
        if (matchBranch && matchBranch[1].trim() === branch && path !== dir) {
          execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
        }
      }
      execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    } catch {
      /* 清理失败就交给下面的重试暴露真实错误 */
    }
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
    const add = () => execFileSync('git', ['-C', config.repoPath, 'worktree', 'add', '-B', branch, dir, config.baseRef], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    try {
      add()
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr).trim() : String(error)
      if (!/already (used|checked out|exists)/i.test(stderr)) throw new Error(redact(`git worktree add 失败：${stderr}`))
      clearStaleWorktree(config.repoPath, branch, dir)
      try {
        add()
      } catch (retryError) {
        const retryStderr = retryError && retryError.stderr ? String(retryError.stderr).trim() : String(retryError)
        throw new Error(redact(`git worktree add 失败：${retryStderr}`))
      }
    }
    return dir
  }

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

  /** 统一的终态落地：状态 + relay + 回写来源。 */
  async function finalize(ticket, { status, summary = '', question = '', link = '' }) {
    const current = store.state.tickets[ticket.id] ?? ticket
    if (current.status === 'done' || current.status === 'failed') return current
    const report = { at: Date.now(), summary, question, link }
    if (status === 'done') markDone(current, report)
    else if (status === 'waiting') markWaiting(current, report)
    else {
      current.lastError = summary || 'worker 报告失败'
      markFailed(current, summary || 'worker 报告失败')
    }
    store.save()
    log(ticket.id, `report ${status}: ${summary}`)
    if (status === 'done') await relay.send(current, 'done').catch(() => {})
    if (status === 'waiting') await relay.send(current, 'needHuman').catch(() => {})
    if (status === 'failed') await relay.send(current, 'failed').catch(() => {})
    await notifySource(current, status === 'waiting' ? 'needHuman' : status)
    return current
  }

  async function failTicket(ticket, message) {
    const current = store.state.tickets[ticket.id] ?? ticket
    if (current.status === 'done' || current.status === 'failed') return
    current.lastError = message
    markFailed(current, message)
    store.save()
    log(ticket.id, `failed: ${message}`)
    await relay.send(current, 'failed').catch(() => {})
    await notifySource(current, 'failed')
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
        await finalize(current, {
          status: args.status,
          summary: redact(String(args.summary ?? '').slice(0, 300)),
          question: redact(String(args.question ?? '').slice(0, 200)),
          link: String(args.link ?? '').slice(0, 500),
        })
        return { ok: true, status: args.status }
      },
    }
    return agent.ctx.tools.register(definition)
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

  /** 子智能体驻留：目标单会话下开一个 worker，完工 dispose + 归档。 */
  async function runSubagent(ticket, targetAgent, workdir) {
    const subagents = getSubagents()
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new Error('宿主没有 subagents 服务，无法以会话内子智能体执行')
    }
    // 名字在父会话的子智能体里必须唯一（历史 catalog 也算），带上轮次/时间后缀避免重跑撞名。
    const shortId = safeSessionId(ticket.id).replace(/^worker-/, '').slice(0, 18)
    const suffix = `${ticket.attempts ?? 0}-${Date.now().toString(36).slice(-4)}`
    const activation = await subagents.startActivation({
      provider: 'spawn',
      parent: targetAgent,
      name: `ticket-${shortId}-${suffix}`.slice(0, 32),
      label: String(ticket.title ?? ticket.id).slice(0, 80),
      cwd: workdir,
      prompt: [{ type: 'text', text: mandate(ticket, workdir) }],
      delivery: 'parent',
      signal: controller.signal,
    })
    ticket.childSessionId = activation.childId
    ticket.mode = 'team'
    store.save()
    log(ticket.id, `subagent ${activation.childId} started @ ${workdir}`)
    // 子智能体继承父会话的权限面；先把它的权限放到 danger-full-access，否则写 worktree 会被沙箱拦。
    try {
      const child = ctx.agents?.get?.(activation.childId)
      if (child) ctx.permissionPresets.set(child.session, 'danger-full-access')
      else log(ticket.id, 'subagent agent 尚未就绪，权限面未提升')
    } catch (error) {
      log(ticket.id, `subagent permission failed: ${error.message}`)
    }
    let result
    try {
      result = await activation.result
    } finally {
      // 完工即卸载：先释放运行时，再归档子会话，别一直占着。
      try {
        await activation.dispose()
      } catch (error) {
        log(ticket.id, `subagent dispose failed: ${error.message}`)
      }
      try {
        if (typeof archiveSession === 'function') await archiveSession(activation.childId)
        else await ctx.workspaceRegistry?.archiveSession?.(activation.childId)
      } catch (error) {
        log(ticket.id, `subagent archive skipped: ${error.message}`)
      }
    }
    const current = store.state.tickets[ticket.id]
    if (current.status === 'done' || current.status === 'failed') return { status: current.status }
    const parsed = parseReport(result?.output, result?.stopReason)
    const report = {
      status: parsed.status,
      summary: redact(parsed.summary),
      question: redact(parsed.question ?? ''),
      link: parsed.link ?? '',
    }
    await finalize(current, report)
    return { status: report.status }
  }

  /** 旧路径（单会话关闭时回退）：顶层 worker-<id> 会话 + ticket_report。 */
  async function runLegacySession(ticket, workdir, preset) {
    const sessionIdWanted = safeSessionId(ticket.id)
    let sessionId = ticket.sessionId || sessionIdWanted
    let result = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) {
      if (result.error.code !== 'session/not-found') throw new Error(`会话不可用：${result.error.code}`)
      const created = await ctx.sessionController.create({ sessionId, cwd: workdir, agentPreset: preset })
      log(ticket.id, `session created ${JSON.stringify(created)}`)
      if (created?.sessionId && created.sessionId !== sessionId) {
        log(ticket.id, `requested session ${sessionId}, host returned ${created.sessionId}`)
        sessionId = created.sessionId
      }
      result = await ctx.sessionController.resolveAgent(sessionId)
    }
    if ('error' in result) throw new Error(`会话创建后不可用：${result.error.code}`)
    const agent = result.agent
    ticket.sessionId = sessionId
    ticket.mode = 'worker'
    store.save()

    try {
      ctx.permissionPresets.set(agent.session, 'danger-full-access')
    } catch (error) {
      log(ticket.id, `permission preset failed: ${error.message}`)
    }
    if (!disposers.has(sessionId)) disposers.set(sessionId, registerReportTool(agent, ticket))

    let waited = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await ctx.sessionController.prompt({
        requestId: `mandate:${ticket.id}:${ticket.attempts}:${attempt}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: mandate(ticket, workdir) }],
      }, controller.signal)
      waited = await ctx.sessionController.wait({ sessionId, timeoutMs: config.workerTimeoutMs, maxMessages: 50 }, controller.signal)
      const after = store.state.tickets[ticket.id]
      if (after.status !== 'running') break
      const hasAssistant = (waited.output?.records ?? []).some((record) => record?.event?.type === 'assistant/message')
      if (hasAssistant || waited.reason === 'timeout' || waited.reason === 'input-required') break
      log(ticket.id, `worker 未启动（wait=${waited.reason}），重投 mandate（第 ${attempt + 1} 次）`)
    }
    const current = store.state.tickets[ticket.id]
    if (current.status === 'done' || current.status === 'waiting') return { status: current.status }
    if (current.status === 'failed') return { status: 'failed' }
    const reason = waited?.reason === 'timeout'
      ? `worker 超时（${Math.round(config.workerTimeoutMs / 1000)}s）未回报`
      : waited?.reason === 'input-required'
        ? 'worker 在等人输入（未调用 ticket_report）'
        : 'worker 结束本轮但未调用 ticket_report'
    await failTicket(current, reason)
    try {
      ctx.sessionController.cancel({ sessionId })
    } catch {
      /* 已空闲 */
    }
    return { status: 'failed' }
  }

  async function runTicket(ticketId) {
    if (busy) return { skipped: 'busy' }
    busy = true
    const ticket = store.state.tickets[ticketId]
    try {
      if (!ticket) throw new Error(`工单不存在：${ticketId}`)
      if (ticket.dryRun) return { skipped: 'dryRun' }
      const signal = controller.signal

      // 1 监管者：值不值得开工（QQ 用模型，其它源直通）
      const verdict = assessment ? await assessment.assess(ticket, signal) : { verdict: 'accept', mode: 'off' }
      if (verdict.verdict === 'ignore' || verdict.verdict === 'stop') {
        await failTicket(ticket, `研判为${verdict.verdict === 'ignore' ? '无关消息' : '要求停止'}${verdict.reason ? `：${verdict.reason}` : ''}`)
        return { status: 'failed', skipped: verdict.verdict }
      }

      // 2/3 单会话模式：定位已登记的单会话 + 调度判定；关闭时走旧 worker 路径，不做这两步
      let targetAgent = null
      let route = { verdict: 'accept', preset: config.workerPreset, mode: 'rules' }
      if (config.singleSession.enabled) {
        const target = targetResolver
          ? await targetResolver.resolve(ticket, verdict, signal)
          : { sessionId: null, error: '没有 targetResolver' }
        if (!target.sessionId) {
          await failTicket(ticket, target.error || '找不到目标单会话')
          return { status: 'failed', skipped: 'no-target' }
        }
        ticket.workspace = target.workspace?.path ?? null
        ticket.targetSessionId = target.sessionId
        store.save()

        const resolved = await ctx.sessionController.resolveAgent(target.sessionId)
        if ('error' in resolved) {
          await failTicket(ticket, `目标单会话不可用：${resolved.error.code}`)
          return { status: 'failed', skipped: 'no-agent' }
        }
        targetAgent = resolved.agent
        if (orchestrator) {
          route = await orchestrator.route(ticket, { sessionId: target.sessionId, agent: targetAgent })
          if (route.verdict === 'ignore' || route.verdict === 'stop') {
            await failTicket(ticket, `调度判定${route.verdict}${route.reason ? `：${route.reason}` : ''}`)
            return { status: 'failed', skipped: route.verdict }
          }
        }
      }

      // 4 目录 + 开工
      const workdir = ensureWorktree(ticket)
      const branch = config.repoPath ? `superagent/${safeSessionId(ticket.id).replace(/^worker-/, '')}` : null
      markRunning(ticket, { workdir, branch, relayed: ticket.relayed })
      store.save()
      log(ticket.id, `start worker @ ${workdir} (mode=${config.singleSession.enabled ? 'team' : 'worker'})`)
      await relay.send(ticket, 'started').catch((error) => log(ticket.id, `relay started failed: ${error.message}`))

      // 5 执行：单会话 → 子智能体；否则回退顶层 worker 会话
      if (config.singleSession.enabled && targetAgent) return await runSubagent(ticket, targetAgent, workdir)
      return await runLegacySession(ticket, workdir, route.preset || config.workerPreset)
    } catch (error) {
      const current = store.state.tickets[ticketId]
      const message = redact(error && error.message ? error.message : String(error))
      if (current && current.status !== 'done' && current.status !== 'failed') {
        await failTicket(current, message).catch(() => {})
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
