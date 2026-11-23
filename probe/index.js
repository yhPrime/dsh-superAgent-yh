/**
 * M0 探针（一次性）：验证 DSH 插件能否
 *  Q1 按指定 sessionId + 目录 + preset 建会话；
 *  Q2 向该会话投递首条消息；
 *  Q3 等到一轮完成并拿到回复；
 *  Q4 取消/关闭该会话；
 *  Q5 宿主进程重启后恢复同一会话并继续对话。
 * 证据写进 evidenceDir/M0-probe-evidence.json，分两次进程运行（phase1 / phase2）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-superagent-yh-m0-probe'
export const inject = ['sessionController', 'workspaceRegistry']

const SESSION_ID = 'worker-m0-probe2'
const PROMPT_1 = '只回复四个字符：M0-OK'
const PROMPT_2 = '只回复七个字符：M0-RESUMED'

const requestId = (tag) => `m0-${tag}-${Date.now().toString(36)}`

function textOf(record) {
  try {
    const data = record?.event?.data
    if (!data) return ''
    const msg = data.message
    if (!msg || !Array.isArray(msg.content)) return ''
    return msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const evidenceDir = config.evidenceDir
  const file = join(evidenceDir, 'M0-probe-evidence.json')
  const workspaceDir = config.workspaceDir
  mkdirSync(evidenceDir, { recursive: true })

  ctx.effect(() => {
    const timer = setTimeout(async () => {
      const evidence = existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : { createdAt: new Date().toISOString(), runs: [] }
      if (evidence.done) return
      const phase = evidence.phase1Done ? 2 : 1
      const run = { phase, pid: process.pid, at: new Date().toISOString(), steps: [] }
      evidence.runs.push(run)
      const step = (n, ok, detail) => run.steps.push({ n, ok: !!ok, detail: detail === undefined ? null : detail })

      try {
        const abort = new AbortController()

        // Q1：建会话（指定 id / 目录 / preset）
        if (phase === 1) {
          try {
            const created = await ctx.sessionController.create({
              sessionId: SESSION_ID,
              cwd: workspaceDir,
              agentPreset: 'standard',
            })
            step('Q1 create', true, created)
          } catch (error) {
            step('Q1 create', false, String(error && error.message ? error.message : error))
          }
        }
        const resolved = await ctx.sessionController.resolveAgent(SESSION_ID)
        const resolvedOk = !('error' in resolved)
        step('Q1 resolveAgent', resolvedOk, resolvedOk ? { id: resolved.agent.id } : resolved.error.code)
        if (!resolvedOk) throw new Error('session not resolvable: ' + resolved.error.code)

        // Q2：投递消息
        const promptText = phase === 1 ? PROMPT_1 : PROMPT_2
        try {
          const accepted = await ctx.sessionController.prompt({
            requestId: requestId('p' + phase),
            sessionId: SESSION_ID,
            mode: 'queue',
            content: [{ type: 'text', text: promptText }],
          }, abort.signal)
          step('Q2 prompt', accepted && accepted.accepted === true, accepted)
        } catch (error) {
          step('Q2 prompt', false, String(error && error.message ? error.message : error))
          throw error
        }

        // Q3：等一轮完成
        const waited = await ctx.sessionController.wait({ sessionId: SESSION_ID, timeoutMs: 240000, maxMessages: 30 }, abort.signal)
        const reply = (waited.output?.records ?? []).map(textOf).filter(Boolean).join(' | ')
        step('Q3 wait', waited.reason === 'idle' && reply.includes(phase === 1 ? 'M0-OK' : 'M0-RESUMED'), {
          reason: waited.reason,
          reply,
          outputTruncated: waited.output?.truncated ?? null,
        })

        const state = await ctx.sessionController.state({ sessionId: SESSION_ID }, abort.signal)
        step('Q3 state', true, state)

        // Q5（phase 2）：确认会话历史跨进程保留，且两轮回复都在
        if (phase === 2) {
          const page = await ctx.sessionController.events(
            { address: { kind: 'session', sessionId: SESSION_ID }, maxMessages: 100 },
            abort.signal,
          )
          const all = (page.records ?? []).map(textOf).join(' | ')
          step('Q5 history', all.includes('M0-OK') && all.includes('M0-RESUMED'), {
            records: (page.records ?? []).length,
            hasMore: page.hasMore,
          })
        }

        // Q4：取消（关闭）会话
        try {
          const cancelled = ctx.sessionController.cancel({ sessionId: SESSION_ID })
          step('Q4 cancel', cancelled && cancelled.accepted === true, cancelled)
        } catch (error) {
          step('Q4 cancel', false, String(error && error.message ? error.message : error))
        }
      } catch (error) {
        step('fatal', false, String(error && error.stack ? error.stack : error))
      }

      const failed = run.steps.some((s) => !s.ok)
      if (!failed) {
        if (phase === 1) evidence.phase1Done = true
        else evidence.done = true
      }
      writeFileSync(file, JSON.stringify(evidence, null, 2), 'utf8')
    }, config.delayMs ?? 2000)
    return () => clearTimeout(timer)
  })

  ctx.logger.info('dsh-superagent-yh M0 probe loaded (workspaceDir=%s)', workspaceDir)
}
