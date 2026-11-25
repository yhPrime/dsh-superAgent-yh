#!/usr/bin/env node
// S6 控制台回归门（一条命令）：
//   node test/tools/console-regression.mjs
//
// 依次做四件事，全绿才退出 0：
//   1. i18n 键集断言（console-i18n-check.mjs：zh/en 零差集、无空值、无未使用键）
//   2. 数据层 + 视图 + 三态单测（node --test 显式文件清单）
//   3. 黑盒五路由冒烟：临时起 console-mock-server，跑 verify-v210 --console，要求退出码 0
//   4. 无服务行为：对已关闭端口跑 verify-v210 --console，要求 5s 内以退出码 2 清晰失败（不 hang、不崩溃）
//
// 真机前置（本脚本不代替）：真正验收前先启动 DSH，再跑
//   node test/tools/verify-v210.mjs http://127.0.0.1:<端口> --console
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './console-mock-server.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const tools = (name) => fileURLToPath(new URL(name, import.meta.url))

function run(scriptPath, args = [], timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: root, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(error), timedOut: false })
    })
  })
}

const steps = []
function check(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

// 1. i18n 键集断言
{
  const result = await run(tools('console-i18n-check.mjs'))
  check('i18n 键集断言（zh/en 零差集、无空值、无未使用键）', result.code === 0, (result.stdout.trim() || result.stderr.trim()).split('\n').at(-1))
}

// 2. 控制台单测（三态 + 视图 + 数据层 + 字典）
{
  const files = [
    'test/unit/console-states.test.js',
    'test/unit/console-view.test.js',
    'test/unit/console-s4.test.js',
    'test/unit/console-s5.test.js',
    'test/unit/console-store.test.js',
    'test/unit/client-dict.test.js',
    'test/unit/client-smoke.test.js',
  ]
  const testRun = await run('--test', files)
  check('控制台单测（三态/视图/数据层/字典）', testRun.code === 0, summarizeTestOutput(testRun.stdout, testRun.stderr))
}

// 3. 五路由冒烟（mock）
{
  const mock = await startMockServer()
  try {
    const result = await run(tools('verify-v210.mjs'), [`http://127.0.0.1:${mock.port}`, '--console'])
    const passLine = result.stdout.split('\n').filter((line) => line.includes('通过')).at(-1) ?? ''
    check('五路由冒烟 --console（mock 宿主）', result.code === 0, `exit=${result.code} ${passLine.trim()}`)
  } finally {
    await mock.close()
  }
}

// 4. 无服务：清晰失败（退出码 2）、不 hang
{
  const probe = await startMockServer()
  const deadPort = probe.port
  await probe.close()
  const startedAt = Date.now()
  const result = await run(tools('verify-v210.mjs'), [`http://127.0.0.1:${deadPort}`, '--console'], 15000)
  const elapsed = Date.now() - startedAt
  const clear = result.code === 2 && `${result.stdout}${result.stderr}`.includes('无法连接')
  check('无服务时清晰失败（exit=2，不 hang）', clear, `exit=${result.code} ${elapsed}ms`)
  if (!clear) console.log(`${result.stderr.trim().split('\n').slice(-3).join('\n')}`)
}

function summarizeTestOutput(stdout, stderr) {
  const text = `${stdout}\n${stderr}`
  const num = (label) => text.match(new RegExp(`${label} (\\d+)`))?.[1]
  const tests = num('ℹ tests') ?? num('# tests')
  const pass = num('ℹ pass') ?? num('# pass')
  const fail = num('ℹ fail') ?? num('# fail')
  const todo = num('ℹ todo') ?? num('# todo')
  if (pass !== undefined || fail !== undefined) return `tests=${tests ?? '?'} pass=${pass ?? '?'} fail=${fail ?? '?'} todo=${todo ?? '0'}`
  return text.trim().split('\n').at(-1) ?? ''
}

const failed = steps.filter((step) => !step.ok)
console.log(`\n${steps.length - failed.length}/${steps.length} 步通过`)
process.exitCode = failed.length === 0 ? 0 : 1
