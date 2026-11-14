<template>
  <section class="migration-panel">
    <header class="migration-head">
      <div>
        <h3>落盘任务升级迁移（v1 → v2）</h3>
        <p class="page-desc">
          旧版数据落盘升级：存储配置的输出路径、文件格式、分区策略、保留天数随历史分区一起迁移，
          先重建批次索引并完整构建部署，成功后才切换写入版本。
        </p>
      </div>
      <div class="writer-badge" :class="status.activeWriter">
        写入版本：{{ status.activeWriter.toUpperCase() }} · 阶段 {{ status.stage }}
      </div>
    </header>

    <div class="migration-actions">
      <button class="btn primary" type="button" @click="migrate('STOR-7')">
        迁移 STOR-7（/collect/a → /archive/b）
      </button>
      <button class="btn" type="button" @click="migrate('STOR-3')">
        迁移 STOR-3（/collect/c → /archive/c）
      </button>
      <button class="btn" type="button" @click="migrate('STOR-7', () => true)">
        模拟部署失败（验证不切版本）
      </button>
      <button class="btn ghost" type="button" @click="rollback">回滚到旧索引与已启用配置</button>
      <button class="btn ghost" type="button" @click="reset">重置迁移状态</button>
    </div>

    <p v-if="message" :class="['migration-message', failed ? 'error-text' : 'ok-text']">
      {{ message }}
    </p>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">旧批次索引条目</span>
        <strong class="stat-value">{{ view.legacyIndexCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">v2 分区索引</span>
        <strong class="stat-value">{{ status.v2Index.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">v2 存储配置</span>
        <strong class="stat-value">{{ status.v2Configs.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">目录锁</span>
        <strong class="stat-value">{{ locks.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">最近提交戳</span>
        <strong class="stat-value stamp">{{ status.lastCommitStamp ?? '—' }}</strong>
      </article>
    </div>

    <table v-if="status.v2Index.length" class="data-table">
      <thead>
        <tr>
          <th>配置</th><th>批次</th><th>分区</th><th>新路径</th>
          <th>格式</th><th>保留天数</th><th>批次结束时间</th><th>保留到期</th><th>摘要</th><th>提交戳</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in status.v2Index" :key="row.batchId + row.partitionPath">
          <td>{{ row.configCode }}</td>
          <td>{{ row.batchId }}</td>
          <td>{{ row.partitionPath }}</td>
          <td>{{ row.targetPath }}</td>
          <td>{{ row.fileFormat }}</td>
          <td>{{ row.retentionDays }}</td>
          <td>{{ row.batchEndAt }}</td>
          <td>{{ row.expireAt }}</td>
          <td>{{ row.digest }}</td>
          <td class="stamp">{{ row.commitStamp }}</td>
        </tr>
      </tbody>
    </table>

    <h4>保留期保护（防止新规则提前删除旧分区）</h4>
    <table v-if="retention.length" class="data-table">
      <thead><tr><th>分区</th><th>到期时刻</th><th>当前是否受保护</th></tr></thead>
      <tbody>
        <tr v-for="item in retention" :key="item.entry.targetPath">
          <td>{{ item.entry.targetPath }}</td>
          <td>{{ item.entry.expireAt }}</td>
          <td :class="item.protected ? 'ok-text' : 'muted-text'">
            {{ item.protected ? '受保护，禁止提前删除' : '已过保留期，可清理' }}
          </td>
        </tr>
      </tbody>
    </table>

    <h4>阶段审计</h4>
    <ul class="audit-list">
      <li v-for="(event, index) in status.audit" :key="index" :class="auditClass(event.stage)">
        <span class="audit-at">{{ event.at }}</span>
        <span class="audit-stage">{{ event.stage }}</span>
        <span class="audit-msg">{{ event.message }}</span>
      </li>
    </ul>
  </section>
)
</template>

<script setup lang="ts">
import { useMigration } from '@/stores/migration'
import type { AuditEvent } from '@/data/migration/types'

const { view, status, locks, retention, message, failed, migrate, rollback, reset } =
  useMigration('2026-11-14T00:00:00.000Z')

function auditClass(stage: AuditEvent['stage']): string {
  if (stage === 'FAILED' || stage === 'LOCK_REJECTED') return 'audit-bad'
  if (stage === 'SWITCHED' || stage === 'DEPLOYED') return 'audit-good'
  return ''
}
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
.migration-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}
.writer-badge {
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.writer-badge.v1 { background: #fef3c7; color: #92400e; }
.writer-badge.v2 { background: #dcfce7; color: #166534; }
.migration-message { font-size: 13px; }
.ok-text { color: #166534; }
.muted-text { color: var(--muted); }
.stamp { font-size: 11px; word-break: break-all; }
h4 { margin: 14px 0 6px; }
.audit-list { list-style: none; padding: 0; margin: 0; font-size: 12px; }
.audit-list li { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px dashed var(--border); }
.audit-at { color: var(--muted); width: 200px; }
.audit-stage { width: 120px; font-weight: 600; }
.audit-bad .audit-stage { color: #b42318; }
.audit-good .audit-stage { color: #166534; }
</style>
