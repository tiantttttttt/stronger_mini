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
  vm.runInNewContext(outputText, { exports, setTimeout, clearTimeout, uni: { request: respond, getStorageSync: () => undefined, setStorageSync: () => {}, removeStorageSync: () => {} } })
  return exports
}

test('创建、更新与统计使用资源接口并保留鉴权', async () => {
  const calls = []
  const api = loadAPI((options) => {
    calls.push(options)
    options.success({
      statusCode: 200,
      data: calls.length === 1 ? { user_id: 'user', access_token: 'test-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600, refresh_expires_in: 2592000 } : { id: 'workout-id', status: 2 },
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
  const api = loadAPI((options) => options.success({ statusCode: 409, data: { code: 400002, message: '当前训练状态不允许此操作' } }))
  await assert.rejects(api.updateWorkout('workout-id', { status: 2 }), error => error.status === 409 && error.code === api.ErrorCode.WorkoutTerminal && error.message === '当前训练状态不允许此操作')
})

test('统计失败可单独重试，不重新发送更新', async () => {
  const methods = []
  let reads = 0
  const api = loadAPI((options) => {
    methods.push(options.method)
    if (options.method === 'GET' && reads++ === 0) {
      options.success({ statusCode: 500, data: { code: 100999, message: '服务暂时不可用，请稍后重试' } })
      return
    }
    options.success({ statusCode: 200, data: { id: 'workout-id', status: 2 } })
  })
  await api.updateWorkout('workout-id', { status: 2 })
  await assert.rejects(api.getWorkoutStat('workout-id'), error => error.status === 500 && error.code === api.ErrorCode.Internal)
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

test('错误保留 HTTP 状态、数字业务码、公开提示和参数名', async () => {
  const api = loadAPI(options => options.success({ statusCode: 400, data: { code: 100001, message: '请求参数错误', parameter: 'id' } }))
  await assert.rejects(api.getProfile(), error => error instanceof api.APIError && error.status === 400 && error.code === api.ErrorCode.InvalidRequest && error.message === '请求参数错误' && error.parameter === 'id')
})

test('网关和非法错误响应使用本地提示，不冒充服务端业务码', async () => {
  for (const body of ['<html>secret upstream</html>', '', null, [], {}, 12, { code: '100002', message: 'legacy secret' }, { code: 100001.5 }, { code: NaN }]) {
    const api = loadAPI(options => options.success({ statusCode: 502, data: body }))
    await assert.rejects(api.getProfile(), error => error.status === 502 && error.code === null && error.message === '请求失败，请稍后重试' && error.parameter === undefined)
  }
})

test('未知数字码原样保留，缺失提示时安全兜底', async () => {
  const api = loadAPI(options => options.success({ statusCode: 409, data: { code: 990001, message: '新业务限制', parameter: 12 } }))
  await assert.rejects(api.getProfile(), error => error.code === 990001 && error.message === '新业务限制' && error.parameter === undefined)
  const fallback = loadAPI(options => options.success({ statusCode: 400, data: { code: 990002 } }))
  await assert.rejects(fallback.getProfile(), error => error.code === 990002 && error.message === '请求失败，请稍后重试')
})
