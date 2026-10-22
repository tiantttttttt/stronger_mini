<template>
  <view class="content">
    <view class="text-area">
      <text class="title">{{ title }}</text>
    </view>
    <text class="subtitle">最短训练闭环</text>
    <button class="primary-button" :loading="busy" @click="runEmptyWorkoutFlow">
      开始空训练并完成
    </button>
    <text class="status">{{ status }}</text>
    <view v-if="summary" class="summary">
      <text>训练 ID：{{ summary.id }}</text>
      <text>状态：{{ summary.status }}</text>
      <text>时长：{{ summary.duration_seconds ?? 0 }} 秒</text>
      <text>动作：{{ summary.completed_exercise_count ?? 0 }}</text>
      <text>组数：{{ summary.completed_set_count ?? 0 }}</text>
      <text>总次数：{{ summary.total_reps ?? 0 }}</text>
      <text>负重训练量：{{ summary.total_volume_kg ?? '0.00' }} kg</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  updateWorkout,
  developmentLogin,
  getWorkoutStat,
  createWorkout,
  type WorkoutStat,
} from '../../api'

const title = ref('Stronger Your Body')
const status = ref('等待开始')
const busy = ref(false)
const summary = ref<WorkoutStat>()

async function runEmptyWorkoutFlow() {
  busy.value = true
  summary.value = undefined
  try {
    status.value = '正在进行开发测试登录…'
    await developmentLogin()
    status.value = '正在开始训练…'
    const workout = await createWorkout()
    status.value = '正在完成训练…'
    await updateWorkout(workout.id, { status: 2 })
    status.value = '正在读取冻结总结…'
    summary.value = await getWorkoutStat(workout.id)
    status.value = '闭环完成'
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}
</script>

<style>
.content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.text-area {
  margin-top: 240rpx;
  display: flex;
  justify-content: center;
}

.title {
  font-size: 36rpx;
  color: #1f2937;
  font-weight: 600;
}

.subtitle {
  margin-top: 24rpx;
  margin-bottom: 48rpx;
  color: #6b7280;
  font-size: 28rpx;
}

button {
  width: 560rpx;
}

.primary-button {
  color: #ffffff;
  background: #2563eb;
}

.status {
  margin-top: 32rpx;
  color: #4b5563;
}

.summary {
  width: 560rpx;
  margin-top: 32rpx;
  padding: 32rpx;
  display: flex;
  flex-direction: column;
  gap: 12rpx;
  border-radius: 20rpx;
  background: #f3f4f6;
  color: #111827;
}
</style>
