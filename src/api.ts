const apiBaseURL = 'http://127.0.0.1:8080/api/v1'

export interface WorkoutSummary {
  id: string
  status: number
  started_at: string
  completed_at?: string
  duration_seconds?: number
  completed_exercise_count?: number
  completed_set_count?: number
  total_reps?: number
  total_volume_kg?: string
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

export function startWorkout(): Promise<WorkoutSummary> {
  return request({ url: '/workouts', method: 'POST' })
}

export function completeWorkout(workoutID: string): Promise<WorkoutSummary> {
  return request({ url: `/workouts/${workoutID}/complete`, method: 'POST' })
}

export function getWorkoutSummary(workoutID: string): Promise<WorkoutSummary> {
  return request({ url: `/workouts/${workoutID}/summary`, method: 'GET' })
}
