import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
const credentials = (name = 'old') => ({ user_id: name, access_token: `${name}-access`, refresh_token: `${name}-refresh`, token_type: 'Bearer', expires_in: 3600, refresh_expires_in: 2592000 })
function fixture(saved) {
  let storage = saved, nextTimer = 0
  const calls = [], logins = [], timers = new Map(), exports = {}
  vm.runInNewContext(outputText, {
    exports,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
    uni: {
      getStorageSync: () => storage,
      setStorageSync: (_, value) => { storage = value },
      removeStorageSync: () => { storage = undefined },
      request: options => calls.push(options), login: options => logins.push(options),
    },
  })
  return {
    api: exports, calls, logins, saved: () => storage,
    reply(index, status, data) { assert.ok(calls[index], `missing request ${index}`); calls[index].success({ statusCode: status, data }) },
    fail(index) { calls[index].fail(new Error('network unavailable')) },
    expire() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn() },
  }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const path = call => new URL(call.url).pathname.replace('/api/v1', '')

async function loginDev(f, name = 'dev') {
  const promise = f.api.developmentLogin(); await flush()
  const index = f.calls.length - 1
  assert.equal(path(f.calls[index]), '/auth/dev/login')
  f.reply(index, 200, credentials(name)); await promise
}

test('恢复凭证、读取和更新档案共用请求封装', async () => {
  const f = fixture(credentials()), read = f.api.getProfile()
  assert.equal(f.calls[0].header.Authorization, 'Bearer old-access')
  f.reply(0, 200, { user_id: 'old', profile_complete: false }); assert.equal((await read).profile_complete, false)
  const data = { height_cm: '170.00', weight_kg: '65.00', training_level: 1, fitness_goal: 3, timezone: 'UTC', nickname: null }
  const update = f.api.updateProfile(data)
  assert.equal(path(f.calls[1]), '/profile'); assert.equal(f.calls[1].method, 'PUT'); assert.equal(f.calls[1].data, data)
  f.reply(1, 200, { profile_complete: true }); assert.equal((await update).profile_complete, true)
})

test('并发 401 合并刷新，认证不携带旧 Access Token', async () => {
  const f = fixture(credentials()), a = f.api.getProfile(), b = f.api.getProfile()
  f.reply(0, 401, { code: 100002, message: '请重新登录' }); f.reply(1, 401, { code: 100002, message: '请重新登录' }); await flush()
  assert.equal(f.calls.length, 3); assert.equal(path(f.calls[2]), '/auth/refresh'); assert.equal(f.calls[2].header.Authorization, undefined)
  f.reply(2, 200, credentials('fresh')); await flush(); assert.equal(f.calls.length, 5)
  for (const i of [3, 4]) { assert.equal(f.calls[i].header.Authorization, 'Bearer fresh-access'); f.reply(i, 200, {}) }
  await Promise.all([a, b]); assert.equal(f.saved().refresh_token, 'fresh-refresh')
})

test('旧令牌迟到的 401 复用新令牌，重试最多一次', async () => {
  const f = fixture(credentials()), a = outcome(f.api.getProfile()), b = f.api.getProfile()
  f.reply(0, 401, { code: 100002, message: '请重新登录' }); await flush(); f.reply(2, 200, credentials('fresh')); await flush()
  f.reply(1, 401, { code: 100002, message: '请重新登录' }); await flush(); assert.equal(f.calls.filter(c => path(c) === '/auth/refresh').length, 1)
  f.reply(3, 401, { code: 100002, message: '请重新登录' }); f.reply(4, 200, {}); assert.equal((await a).error.status, 401); await b
  assert.equal(f.calls.length, 5)
})

test('刷新途中退出等待新凭证撤销，不重放业务请求', async () => {
  const f = fixture(credentials()), read = outcome(f.api.getProfile())
  f.reply(0, 401, { code: 100002, message: '请重新登录' }); await flush(); const exit = f.api.logout(); assert.equal(f.saved(), undefined)
  f.reply(1, 200, credentials('fresh')); await flush()
  assert.equal(path(f.calls[2]), '/auth/logout'); assert.equal(f.calls[2].data.refresh_token, 'fresh-refresh')
  f.reply(2, 204, ''); await exit; assert.match((await read).error.message, /session changed/)
  assert.equal(f.calls.length, 3); assert.equal(f.saved(), undefined)
})

test('刷新超时退出清理本地，迟到新凭证只撤销', async () => {
  const f = fixture(credentials()), read = outcome(f.api.getProfile())
  f.reply(0, 401, { code: 100002, message: '请重新登录' }); await flush(); const exit = f.api.logout(); f.expire(); await flush()
  assert.equal(f.calls[2].data.refresh_token, 'old-refresh'); f.reply(2, 204, ''); await exit; await read
  f.reply(1, 200, credentials('late')); await flush(); assert.equal(f.calls[3].data.refresh_token, 'late-refresh')
  f.reply(3, 204, ''); await flush(); assert.equal(f.saved(), undefined)
})

test('刷新失败只清理对应会话，不重放业务请求', async () => {
  const f = fixture(credentials()), read = outcome(f.api.getProfile())
  f.reply(0, 401, { code: 100002, message: '请重新登录' }); await flush(); f.reply(1, 401, { code: 200002, message: '登录会话已失效，请重新登录' })
  assert.equal((await read).error.status, 401); assert.equal(f.saved(), undefined); assert.equal(f.calls.length, 2)
})

test('退出失败可见且保持本地退出', async () => {
  const f = fixture(credentials()), exit = outcome(f.api.logout()); await flush(); f.fail(0)
  assert.match((await exit).error.message, /network/); assert.equal(f.saved(), undefined)
})

test('重复微信登录合并获取 code 和请求', async () => {
  const f = fixture(), a = f.api.wechatLogin(), b = f.api.wechatLogin(); assert.equal(a, b)
  await flush(); assert.equal(f.logins.length, 1); f.logins[0].success({ code: 'one-code' }); await flush()
  assert.equal(f.calls.length, 1); assert.equal(path(f.calls[0]), '/auth/wechat/login'); assert.equal(f.calls[0].data.code, 'one-code')
  f.reply(0, 200, credentials('wechat')); await Promise.all([a, b]); assert.equal(f.saved().user_id, 'wechat')
})

test('登录途中退出重登，先撤销旧登录再发送新登录', async () => {
  const f = fixture(), old = outcome(f.api.developmentLogin()); await flush()
  const exit = f.api.logout(), next = f.api.developmentLogin(); await flush(); assert.equal(f.calls.length, 1)
  f.reply(0, 200, credentials('old-login')); await flush(); assert.equal(path(f.calls[1]), '/auth/logout'); assert.equal(f.saved(), undefined)
  f.reply(1, 204, ''); await flush(); await exit; assert.equal(path(f.calls[2]), '/auth/dev/login')
  f.reply(2, 200, credentials('next')); await next; assert.match((await old).error.message, /session changed/); assert.equal(f.saved().user_id, 'next')
})

test('队列中的新登录再次退出后取消', async () => {
  const f = fixture(), old = outcome(f.api.developmentLogin()); await flush()
  const exit = f.api.logout(), next = outcome(f.api.developmentLogin()), exitAgain = f.api.logout()
  f.reply(0, 200, credentials()); await flush(); f.reply(1, 204, '')
  const result = await Promise.all([old, exit, next, exitAgain]); assert.match(result[2].error.message, /session changed/)
  assert.equal(f.calls.length, 2); assert.equal(f.saved(), undefined)
})

test('旧登录超时释放队列，迟到成功不覆盖新登录', async () => {
  const f = fixture(), old = outcome(f.api.developmentLogin()); await flush()
  const exit = f.api.logout(), next = f.api.developmentLogin(); f.expire(); await flush(); await exit
  assert.equal(path(f.calls[1]), '/auth/dev/login'); f.reply(1, 200, credentials('next')); await next
  f.reply(0, 200, credentials('late')); await flush(); assert.equal(f.calls[2].data.refresh_token, 'late-refresh')
  f.reply(2, 204, ''); await flush(); await old; assert.equal(f.saved().user_id, 'next')
})

test('刷新途中退出重登，旧响应不清理新账号', async () => {
  const f = fixture(credentials()), read = outcome(f.api.getProfile()); f.reply(0, 401, { code: 100002, message: '请重新登录' }); await flush()
  const exit = f.api.logout(), next = f.api.developmentLogin(); f.expire(); await flush()
  f.reply(2, 204, ''); await flush(); await exit; f.reply(3, 200, credentials('next')); await next
  f.reply(1, 200, credentials('late')); await flush(); assert.equal(f.calls[4].data.refresh_token, 'late-refresh')
  f.fail(4); await flush(); await read; assert.equal(f.saved().user_id, 'next')
})

test('认证失败和微信 code 超时后可以重试', async () => {
  const f = fixture(), first = outcome(f.api.wechatLogin()); await flush(); f.expire(); await first
  const second = outcome(f.api.wechatLogin()); await flush(); f.logins[1].success({ code: 'retry' }); await flush()
  f.reply(0, 401, { code: 200001, message: '微信登录凭证无效，请重新登录' }); await second; await loginDev(f); assert.equal(f.saved().user_id, 'dev')
})

test('退出后旧业务成功响应不交给新账号', async () => {
  const f = fixture(credentials()), read = outcome(f.api.getProfile()), exit = f.api.logout()
  await flush(); f.reply(1, 204, ''); await exit; f.reply(0, 200, { user_id: 'old' }); assert.match((await read).error.message, /session changed/)
})

test('仅 HTTP 401 且业务码为访问凭证失效时触发刷新', async () => {
  for (const [status, body] of [
    [401, { code: 200001, message: '微信登录凭证无效' }],
    [401, { code: 200002, message: '刷新凭证失效' }],
    [401, { code: 990001, message: '未知业务错误' }],
    [401, {}],
    [401, { code: 'unauthorized' }],
    [403, { code: 100002, message: '请重新登录' }],
  ]) {
    const f = fixture(credentials()), read = outcome(f.api.getProfile())
    f.reply(0, status, body)
    const result = await read
    assert.equal(result.error.status, status)
    assert.equal(f.calls.length, 1)
    assert.equal(f.saved().user_id, 'old')
  }
})
