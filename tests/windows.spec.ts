/** Windows smoke tests: the parts of the worker environment whose POSIX behavior the official suite describes. */
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executable, workerProbe } from '../src/deployment.ts'
import { workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('the worker environment on Windows', () => {
  it('writes batch shims for gh and lark-cli, and runs them through cmd', async () => {
    const gh = join(dir, 'gh.exe')
    writeFileSync(gh, '', { mode: 0o755 }); chmodSync(gh, 0o755)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github!, cli: gh }, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd', 'personal-gh.cmd'])
    expect(readFileSync(join(bin, 'gh.cmd'), 'utf8')).toContain(gh)
    const { stderr } = await exec('cmd', ['/c', join(bin, 'personal-gh.cmd')]).then(() => ({ stderr: '' }), (error: { stderr?: string }) => ({ stderr: error.stderr ?? '' }))
    expect(stderr).toContain('personal-gh is blocked in this installation; use gh, which acts as agent-bot.')
  })

  it('resolves a command through PATHEXT, and a configured absolute path as written', () => {
    const tool = join(dir, 'tool.cmd'); writeFileSync(tool, '@echo off\r\n')
    expect(executable('tool', dir)).toBe(tool)
    const bare = join(dir, 'bare-agent'); writeFileSync(bare, '')
    expect(executable(bare, dir)).toBe(bare)
  })

  it('probes the agent CLI with an environment that leaves the worker shims off PATH', async () => {
    const specs: { argv: string[]; env?: Record<string, string> }[] = []
    const subprocess = { spawn: (spec: { argv: string[]; env?: Record<string, string> }) => {
      specs.push(spec)
      const readFrom = () => ({ text: '', nextOffset: 0, lossy: false })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom }, stderr: { readFrom } } }
    } }
    const cwd = join(dir, 'cwd'); mkdirSync(cwd)
    await workerProbe(subprocess as never, dir, cwd, new AbortController().signal)(['gh', 'api', 'user'])
    expect(specs[0]!.argv).toEqual(['gh', 'api', 'user'])
    expect(specs[0]!.env?.PATH?.split(';')).not.toContain(workerBin(dir))
  })
})
