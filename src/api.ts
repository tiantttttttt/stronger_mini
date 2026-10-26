const apiBaseURL = 'http://127.0.0.1:8080/api/v1'

export interface WorkoutRecord {
  id: string
  status: number
  started_at: string
  completed_at?: string
}

export interface WorkoutStat extends WorkoutRecord {
  duration_seconds?: number
  completed_exercise_count?: number
  completed_set_count?: number
  total_reps?: number
  total_volume_kg?: string
}

export interface UpdateWorkout {
  status: 2 // 当前仅支持完成训练。
}

export interface LoginSession {
  user_id: string
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  refresh_expires_in: number
}

export interface Profile {
  user_id: string
  height_cm: string | null
  weight_kg: string | null
  training_level: number | null
  fitness_goal: number | null
  timezone: string
  nickname: string | null
  avatar_url: string | null
  gender: number | null
  birth_year: number | null
  profile_complete: boolean
  missing_fields: string[]
}

export interface UpdateProfile {
  height_cm: string
  weight_kg: string
  training_level: 1 | 2 | 3
  fitness_goal: 1 | 2 | 3
  timezone: string
  nickname?: string | null
  avatar_url?: string | null
  gender?: 1 | 2 | 3 | null
  birth_year?: number | null
}

const storageKey = 'stronger.session'
const requestTimeout = 10000
let generation = 0
let session = restoreSession()
let authTail: Promise<void> = Promise.resolve()
let loginFlight: { generation: number; kind: string; promise: Promise<LoginSession> } | undefined
let refreshFlight: { generation: number; promise: Promise<LoginSession> } | undefined

function validSession(value: unknown): value is LoginSession {
  const item = value as LoginSession | undefined
  return !!item && typeof item.user_id === 'string' && !!item.user_id &&
    typeof item.access_token === 'string' && !!item.access_token &&
    typeof item.refresh_token === 'string' && !!item.refresh_token &&
    item.token_type === 'Bearer' && Number.isFinite(item.expires_in) &&
    item.expires_in > 0 && Number.isFinite(item.refresh_expires_in) && item.refresh_expires_in >= 0
}

function restoreSession(): LoginSession | undefined {
  try {
    const saved: unknown = uni.getStorageSync(storageKey)
    return validSession(saved) ? saved : undefined
  } catch { return undefined }
}

function saveSession(value: LoginSession): void {
  if (!validSession(value)) throw new Error('invalid login response')
  uni.setStorageSync(storageKey, value)
  session = value
}

function clearSession(): void {
  session = undefined
  uni.removeStorageSync(storageKey)
}

// 与服务端业务码契约保持一致；业务逻辑只使用这些具名常量。
export const ErrorCode = {
  InvalidRequest: 100001,
  Unauthorized: 100002,
  RouteNotFound: 100003,
  MethodNotAllowed: 100004,
  DatabaseUnavailable: 100005,
  Internal: 100999,
  WechatCode: 200001,
  RefreshToken: 200002,
  UserDisabled: 200003,
  WechatUnavailable: 200004,
  WechatUnconfigured: 200005,
  UserNotFound: 300001,
  ProfileIncomplete: 300002,
  WorkoutNotFound: 400001,
  WorkoutTerminal: 400002,
} as const

export class APIError extends Error {
  constructor(public status: number, public code: number | null, message: string, public parameter?: string, public requestId?: string) {
    super(message)
    this.name = 'APIError'
  }
}

function parseAPIError(status: number, body: unknown, requestId?: string): APIError {
  const fallback = '请求失败，请稍后重试'
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new APIError(status, null, fallback, undefined, requestId)
  const data = body as { code?: unknown; message?: unknown; parameter?: unknown }
  if (typeof data.code !== 'number' || !Number.isSafeInteger(data.code)) return new APIError(status, null, fallback, undefined, requestId)
  const message = typeof data.message === 'string' && data.message.trim() ? data.message : fallback
  const parameter = typeof data.parameter === 'string' ? data.parameter : undefined
  return new APIError(status, data.code, message, parameter, requestId)
}

function responseRequestId(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-request-id' && typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

// 所有请求都有独立超时；认证迟到结果只用于尽力撤销，不再写入会话。
function send<T>(options: UniApp.RequestOptions, token?: string, onLateSuccess?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('request timeout')) }
    }, requestTimeout)
    function fail(error: unknown) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    try {
      uni.request({
        ...options,
        url: apiBaseURL + options.url,
        timeout: requestTimeout,
        header: { ...(options.header ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        success(response) {
          const success = response.statusCode >= 200 && response.statusCode < 300
          if (settled) {
            if (success) onLateSuccess?.(response.data as T)
            return
          }
          settled = true
          clearTimeout(timer)
          if (success) { resolve(response.data as T); return }
          reject(parseAPIError(response.statusCode, response.data, responseRequestId(response.header)))
        },
        fail,
      })
    } catch (error) { fail(error) }
  })
}

function revoke(refreshToken: string): Promise<void> {
  return send({ url: '/auth/logout', method: 'POST', data: { refresh_token: refreshToken } })
}

function discardLate(value: LoginSession): void {
  if (validSession(value)) void revoke(value.refresh_token).catch(() => undefined)
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const promise = authTail.then(operation)
  authTail = promise.then(() => undefined, () => undefined)
  return promise
}

// 先切换代次并清除本地状态；服务端撤销仍使用该代次捕获的凭证。
function leaveSession(): () => Promise<void> {
  const previous = session
  const refreshing = refreshFlight?.generation === generation ? refreshFlight.promise : undefined
  generation++
  clearSession()
  return async () => {
    let credential = previous?.refresh_token
    if (refreshing) {
      try { credential = (await refreshing).refresh_token } catch { /* 使用最后已知凭证尽力撤销。 */ }
    }
    if (credential) await revoke(credential)
  }
}

function login(kind: string, credentials: () => Promise<UniApp.RequestOptions>): Promise<LoginSession> {
  if (loginFlight?.generation === generation && loginFlight.kind === kind) return loginFlight.promise
  const cleanup = leaveSession()
  const current = generation
  const promise = enqueue(async () => {
    await cleanup().catch(() => undefined)
    if (current !== generation) throw new Error('session changed')
    const options = await credentials()
    if (current !== generation) throw new Error('session changed')
    const result = await send<LoginSession>(options, undefined, discardLate)
    if (current !== generation) {
      if (validSession(result)) await revoke(result.refresh_token).catch(() => undefined)
      throw new Error('session changed')
    }
    try { saveSession(result) } catch (error) { discardLate(result); throw error }
    return result
  })
  const flight = { generation: current, kind, promise }
  loginFlight = flight
  void promise.then(() => { if (loginFlight === flight) loginFlight = undefined }, () => { if (loginFlight === flight) loginFlight = undefined })
  return promise
}

function wechatCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { settled = true; reject(new Error('wechat login timeout')) }, requestTimeout)
    uni.login({
      provider: 'weixin',
      success(result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result.code) resolve(result.code)
        else reject(new Error('wechat login code missing'))
      },
      fail(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    })
  })
}

export function wechatLogin(): Promise<LoginSession> {
  return login('wechat', async () => ({ url: '/auth/wechat/login', method: 'POST', data: { code: await wechatCode() } }))
}

export async function developmentLogin(): Promise<void> {
  await login('dev', async () => ({ url: '/auth/dev/login', method: 'POST', data: { user_id: '00000000-0000-0000-0000-000000000001' } }))
}

function refreshCurrent(): Promise<LoginSession> {
  if (refreshFlight?.generation === generation) return refreshFlight.promise
  if (!session) return Promise.reject(new Error('not logged in'))
  const current = generation
  const promise = send<LoginSession>({ url: '/auth/refresh', method: 'POST', data: { refresh_token: session.refresh_token } }, undefined, discardLate)
    .then(result => {
      if (current === generation) {
        try { saveSession(result) } catch (error) { discardLate(result); throw error }
      }
      return result
    }).catch(error => {
      if (current === generation) { generation++; clearSession() }
      throw error
    })
  const flight = { generation: current, promise }
  refreshFlight = flight
  void promise.then(() => { if (refreshFlight === flight) refreshFlight = undefined }, () => { if (refreshFlight === flight) refreshFlight = undefined })
  return promise
}

export async function refreshSession(): Promise<LoginSession> {
  const current = generation
  const result = await refreshCurrent()
  if (current !== generation) throw new Error('session changed')
  return result
}

export function logout(): Promise<void> {
  return enqueue(leaveSession())
}

async function request<T>(options: UniApp.RequestOptions): Promise<T> {
  const current = generation
  const token = session?.access_token
  try {
    const result = await send<T>(options, token)
    if (current !== generation) throw new Error('session changed')
    return result
  } catch (error) {
    if (current !== generation) throw new Error('session changed')
    if (!(error instanceof APIError) || error.status !== 401 || error.code !== ErrorCode.Unauthorized || !session) throw error
    // 较晚返回的旧令牌 401 直接使用已更新的凭证，避免再次轮换。
    if (session.access_token === token) await refreshCurrent()
    if (current !== generation) throw new Error('session changed')
    const result = await send<T>(options, session?.access_token)
    if (current !== generation) throw new Error('session changed')
    return result
  }
}

export function getProfile(): Promise<Profile> {
  return request({ url: '/profile', method: 'GET' })
}

export function updateProfile(data: UpdateProfile): Promise<Profile> {
  return request({ url: '/profile', method: 'PUT', data })
}

export function createWorkout(): Promise<WorkoutRecord> {
  return request({ url: '/workouts', method: 'POST' })
}

export function updateWorkout(workoutID: string, data: UpdateWorkout): Promise<WorkoutRecord> {
  return request({ url: `/workouts/${workoutID}`, method: 'PUT', data })
}

export function getWorkoutStat(workoutID: string): Promise<WorkoutStat> {
  return request({ url: `/workouts/${workoutID}/stat`, method: 'GET' })
}
