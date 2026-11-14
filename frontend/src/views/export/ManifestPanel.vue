<template>
  <section class="migration-panel">
    <header class="migration-head">
      <div>
        <h3>数据分发清单（读取迁移同一提交戳）</h3>
        <p class="page-desc">
          本入口不单独生成提交戳，直接读取数据落盘迁移侧最近一次提交戳对应的分发清单，
          保证分发的分区路径、摘要与迁移结果完全一致。
        </p>
      </div>
      <div class="writer-badge">提交戳：{{ manifest.commitStamp ?? '—' }}</div>
    </header>

    <table v-if="manifest.items.length" class="data-table">
      <thead>
        <tr>
          <th>提交戳</th><th>配置</th><th>批次</th><th>目标路径</th>
          <th>格式</th><th>摘要</th><th>条数</th><th>保留到期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in manifest.items" :key="item.commitStamp + item.targetPath">
          <td class="stamp">{{ item.commitStamp }}</td>
          <td>{{ item.configCode }}</td>
          <td>{{ item.batchId }}</td>
          <td>{{ item.targetPath }}</td>
          <td>{{ item.fileFormat }}</td>
          <td>{{ item.digest }}</td>
          <td>{{ item.rowCount }}</td>
          <td>{{ item.expireAt }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">暂无已提交迁移的分发清单，请先在「数据落盘」页完成迁移。</p>
  </section>
</template>

<script setup lang="ts">
import { useMigration } from '@/stores/migration'

// 与数据落盘页共用同一个迁移状态来源，提交戳天然一致
const { manifest } = useMigration()
</script>

<style scoped>
.migration-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 16px 0;
}
.migration-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.writer-badge {
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  background: #eef2f7;
  white-space: nowrap;
}
.stamp { font-size: 11px; word-break: break-all; }
</style>
