import { computed, ref } from 'vue'

import {
  getMigrationView,
  readDistributionManifest,
  resetAll,
  retentionView,
  rollbackMigration,
  runMigration,
  type MigrationView,
} from '@/api/migration-service'

/**
 * 落盘升级迁移的页面状态封装：数据落盘页与数据分发页共用，
 * 保证两个入口读到的提交戳、清单与迁移状态始终来自同一份 localStorage。
 */
export function useMigration(nowIso: string = new Date().toISOString()) {
  const view = ref<MigrationView>(getMigrationView())
  const message = ref('')
  const failed = ref(false)

  const status = computed(() => view.value.status)
  const locks = computed(() => Object.values(status.value.locks))

  function refresh() {
    view.value = getMigrationView()
  }

  async function migrate(configCode: string, deployShouldFail: () => boolean = () => false) {
    failed.value = false
    const result = runMigration(configCode, nowIso, deployShouldFail)
    message.value = result.message
    failed.value = !result.ok
    view.value = result.view
  }

  async function rollback() {
    const result = rollbackMigration(nowIso)
    message.value = result.message
    failed.value = !result.ok
    view.value = result.view
  }

  function reset() {
    view.value = resetAll()
    message.value = '迁移状态已重置为初始态'
    failed.value = false
  }

  const retention = computed(() =>
    status.value.v2Index.length ? retentionView(nowIso) : [],
  )

  const manifest = computed(() => readDistributionManifest())

  return {
    view,
    status,
    locks,
    retention,
    manifest,
    message,
    failed,
    refresh,
    migrate,
    rollback,
    reset,
  }
}
