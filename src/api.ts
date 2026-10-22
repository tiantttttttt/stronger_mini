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

let accessToken = ''

function request<T>(options: UniApp.RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    uni.request({
      ...options,
      url: apiBaseURL + options.url,
      header: {
        ...(options.header ?? {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T)
          return
        }
        reject(new Error(`API ${response.statusCode}: ${JSON.stringify(response.data)}`))
      },
      fail: reject,
    })
  })
}

export async function developmentLogin(): Promise<void> {
  const response = await request<{ access_token: string }>({
    url: '/auth/dev/login',
    method: 'POST',
    data: { user_id: '00000000-0000-0000-0000-000000000001' },
  })
  accessToken = response.access_token
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
