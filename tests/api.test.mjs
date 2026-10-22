import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function loadAPI(respond) {
  const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const exports = {}
  vm.runInNewContext(outputText, { exports, uni: { request: respond } })
  return exports
}

test('创建、更新与统计使用资源接口并保留鉴权', async () => {
  const calls = []
  const api = loadAPI((options) => {
    calls.push(options)
    options.success({
      statusCode: 200,
      data: calls.length === 1 ? { access_token: 'test-token' } : { id: 'workout-id', status: 2 },
    })
  })
  await api.developmentLogin()
  await api.createWorkout()
  await api.updateWorkout('workout-id', { status: 2 })
  await api.getWorkoutStat('workout-id')
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['http://127.0.0.1:8080/api/v1/auth/dev/login', 'POST'],
    ['http://127.0.0.1:8080/api/v1/workouts', 'POST'],
    ['http://127.0.0.1:8080/api/v1/workouts/workout-id', 'PUT'],
    ['http://127.0.0.1:8080/api/v1/workouts/workout-id/stat', 'GET'],
  ])
  assert.deepEqual(calls[2].data, { status: 2 })
  for (const call of calls.slice(1)) {
    assert.equal(call.header.Authorization, 'Bearer test-token')
  }
})

test('更新失败向调用方返回错误', async () => {
  const api = loadAPI((options) => options.success({ statusCode: 409, data: { code: 'workout_terminal' } }))
  await assert.rejects(api.updateWorkout('workout-id', { status: 2 }), /API 409.*workout_terminal/)
})

test('统计失败可单独重试，不重新发送更新', async () => {
  const methods = []
  let reads = 0
  const api = loadAPI((options) => {
    methods.push(options.method)
    if (options.method === 'GET' && reads++ === 0) {
      options.success({ statusCode: 500, data: { code: 'internal_error' } })
      return
    }
    options.success({ statusCode: 200, data: { id: 'workout-id', status: 2 } })
  })
  await api.updateWorkout('workout-id', { status: 2 })
  await assert.rejects(api.getWorkoutStat('workout-id'), /API 500/)
  await api.getWorkoutStat('workout-id')
  assert.deepEqual(methods, ['PUT', 'GET', 'GET'])
})

test('网络失败不会由 API 层自动重放写入', async () => {
  let requests = 0
  const api = loadAPI((options) => {
    requests++
    options.fail(new Error('network unavailable'))
  })
  await assert.rejects(api.createWorkout(), /network unavailable/)
  assert.equal(requests, 1)
})
