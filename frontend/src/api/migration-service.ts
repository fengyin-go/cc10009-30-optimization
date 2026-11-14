import {
  buildDistributionManifest,
  buildMigration,
  buildPlans,
  isPartitionProtected,
  rebuildBatchIndex,
  rollback as rollbackEngine,
  validateDeployment,
  type RebuildReport,
} from '@/data/migration/engine'
import {
  appendAudit,
  appendManifest,
  loadLegacyIndex,
  loadManifest,
  loadMigrationStatus,
  resetMigration,
  saveMigrationStatus,
} from '@/data/migration/migration-store'
import { LEGACY_CONFIGS, TARGET_ROOTS } from '@/data/migration/legacy-seed'
import type {
  AuditEvent,
  DistributionManifestItem,
  MigrationStatus,
  V2IndexEntry,
} from '@/data/migration/types'

/**
 * 迁移编排服务，对应调用链里的「动作流转」层（与 local-service 同层）。
 *
 * 阶段顺序（任一阶段失败即整体回滚，写入版本始终留在 v1）：
 *   加目录锁 → 重建批次索引 → 构建 v2（配置随分区迁移）
 *   → 部署校验 → 切写入版本 v2 → 释放锁
 */

export type MigrationView = {
  status: MigrationStatus
  rebuildReport: RebuildReport | null
  manifest: DistributionManifestItem[]
  /** 旧索引当前条目，页面用来展示缺陷与修复结果 */
  legacyIndexCount: number
}

export type MigrationResult = {
  ok: boolean
  message: string
  view: MigrationView
}

function snapshotView(): MigrationView {
  return {
    status: loadMigrationStatus(),
    rebuildReport: null,
    manifest: loadManifest(),
    legacyIndexCount: loadLegacyIndex().length,
  }
}

function fail(status: MigrationStatus, commitStamp: string, message: string, nowIso: string): never {
  const withAudit = appendAudit(status, 'FAILED', commitStamp, message, nowIso)
  saveMigrationStatus(withAudit)
  throw new MigrationError(message, withAudit)
}

export class MigrationError extends Error {
  status: MigrationStatus
  constructor(message: string, status: MigrationStatus) {
    super(message)
    this.name = 'MigrationError'
    this.status = status
  }
}

function newCommitStamp(nowIso: string): string {
  // 提交戳带毫秒与随机后缀，同目录并发提交可据此区分
  const rand = Math.random().toString(36).slice(2, 8)
  return `MIG-${nowIso.replace(/[-:.]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${rand}`
}

/** 释放单个目录的提交锁，不影响其他目录可能正在进行的提交。 */
function releaseLock(
  status: MigrationStatus,
  configCode: string,
): MigrationStatus {
  const locks = { ...status.locks }
  delete locks[configCode]
  return { ...status, locks }
}

/**
 * 执行一次完整迁移。
 * @param configCode 目录（存储配置）编号；同一目录并发提交只允许一个完成
 * @param nowIso 注入当前时刻，保证测试与保留期计算可复现
 * @param deployShouldFail 测试钩子：模拟部署失败，验证不会切写入版本
 */
export function runMigration(
  configCode: string,
  nowIso: string = new Date().toISOString(),
  deployShouldFail: () => boolean = () => false,
): MigrationResult {
  const commitStamp = newCommitStamp(nowIso)
  let status = loadMigrationStatus()

  // 1) 同目录并发提交锁：只锁同一目录，不同目录的提交可并行
  const held = status.locks[configCode]
  if (held) {
    const message = `目录 ${configCode} 已有进行中的提交 ${held.commitStamp}，本次提交 ${commitStamp} 被拒绝（同目录只允许一个完成）`
    status = appendAudit(status, 'LOCK_REJECTED', commitStamp, message, nowIso)
    saveMigrationStatus(status)
    return { ok: false, message, view: snapshotView() }
  }

  status = {
    ...status,
    locks: { ...status.locks, [configCode]: { configCode, commitStamp, since: nowIso } },
  }
  status = appendAudit(status, 'LOCK', commitStamp, `目录 ${configCode} 提交锁已获取`, nowIso)
  saveMigrationStatus(status)

  // 回滚快照先于任何变更落盘：旧索引 + 旧已启用配置 + 当前写入版本，
  // 这样即使后续任一阶段失败，都能原样恢复旧索引与已启用配置。
  const legacyIndex = loadLegacyIndex()
  const snapshot = {
    legacyIndex: legacyIndex.map((e) => ({ ...e })),
    legacyConfigs: LEGACY_CONFIGS.map((c) => ({ ...c })),
    activeWriter: status.activeWriter,
    stage: status.stage,
  }
  status = { ...status, rollbackSnapshot: snapshot }
  saveMigrationStatus(status)

  try {
    // 2) 定位批次索引问题并重建：回到磁盘分区清单，复合键修复单键覆盖
    const { entries: rebuiltIndex, report } = rebuildBatchIndex(legacyIndex)
    void rebuiltIndex
    if (report.duplicateCompositeKeys.length > 0) {
      fail(status, commitStamp, `重建索引发现重复复合键：${report.duplicateCompositeKeys.join(',')}`, nowIso)
    }

    const plans = buildPlans().filter((plan) => plan.configCode === configCode)
    if (plans.length === 0) {
      fail(status, commitStamp, `没有找到已启用配置 ${configCode} 的迁移计划`, nowIso)
    }
    // 同一目录已迁移过则拒绝重复提交，避免覆盖既有 v2 索引与提交戳
    const alreadyMigrated = status.v2Index.some((entry) => entry.configCode === configCode)
    if (alreadyMigrated) {
      fail(status, commitStamp, `目录 ${configCode} 已完成迁移，如需重做请先回滚或重置`, nowIso)
    }

    // 3) 构建：输出路径/文件格式/分区策略/保留天数随历史分区迁移
    status = appendAudit(status, 'INDEX_REBUILT', commitStamp,
      `批次索引重建完成：旧索引 ${report.legacyIndexCount} 条 → 新索引 ${report.rebuiltCount} 条，补回 ${report.recoveredKeys.length} 条`,
      nowIso)
    saveMigrationStatus(status)

    const built = buildMigration(plans, commitStamp, nowIso)
    status = appendAudit(status, 'BUILT', commitStamp,
      `v2 构建完成：配置 ${built.v2Configs.length} 份、分区索引 ${built.v2Index.length} 条`, nowIso)
    saveMigrationStatus(status)

    // 4) 部署：只有完整构建并部署成功后才切换写入版本
    validateDeployment(built)
    if (deployShouldFail()) {
      fail(status, commitStamp, '部署失败（注入故障）：保留 v1 写入，不切换版本', nowIso)
    }
    status = appendAudit(status, 'DEPLOYED', commitStamp, '部署校验通过，新索引已落盘', nowIso)
    saveMigrationStatus(status)

    // 5) 切换写入版本（此刻才允许写 v2）。
    //    多个目录分批迁移时按 configCode 合并，保留其他目录已迁移的结果。
    const otherConfigs = status.v2Configs.filter((c) => c.configCode !== configCode)
    const otherIndex = status.v2Index.filter((entry) => entry.configCode !== configCode)
    status = {
      ...status,
      activeWriter: 'v2',
      stage: 'SWITCHED',
      lastCommitStamp: commitStamp,
      plans: [...status.plans.filter((p) => p.configCode !== configCode), ...plans],
      v2Configs: [...otherConfigs, ...built.v2Configs],
      v2Index: [...otherIndex, ...built.v2Index],
      rollbackSnapshot: snapshot,
    }
    status = appendAudit(status, 'SWITCHED', commitStamp, '写入版本已切换到 v2', nowIso)

    // 6) 分发清单按同一提交戳写入，另一个入口读同戳
    const manifestItems = buildDistributionManifest(built.v2Index, commitStamp)
    appendManifest(manifestItems)

    // 7) 释放目录锁
    status = releaseLock(status, configCode)
    saveMigrationStatus(status)

    return {
      ok: true,
      message: `配置 ${configCode} 迁移完成，提交戳 ${commitStamp}，写入版本 v2`,
      view: {
        status,
        rebuildReport: report,
        manifest: loadManifest(),
        legacyIndexCount: legacyIndex.length,
      },
    }
  } catch (error) {
    // 任何阶段失败：恢复旧索引与已启用配置，写入版本回 v1，释放本目录锁
    const rolled = rollbackEngine(snapshot)
    const reverted: MigrationStatus = {
      ...releaseLock(status, configCode),
      activeWriter: rolled.activeWriter,
      stage: 'ROLLED_BACK',
      audit: [
        ...status.audit,
        {
          at: nowIso,
          stage: 'ROLLED_BACK' as const,
          commitStamp,
          message: `已回滚：恢复旧索引 ${rolled.legacyIndex.length} 条与已启用配置 ${rolled.legacyConfigs.length} 份，写入版本保持 v1`,
        },
      ],
    }
    saveMigrationStatus(reverted)
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `迁移失败并已回滚：${reason}`,
      view: {
        status: reverted,
        rebuildReport: null,
        manifest: loadManifest(),
        legacyIndexCount: rolled.legacyIndex.length,
      },
    }
  }
}

/** 手动回滚：上线后发现问题，恢复旧索引与已启用配置。 */
export function rollbackMigration(
  nowIso: string = new Date().toISOString(),
): MigrationResult {
  const status = loadMigrationStatus()
  if (!status.rollbackSnapshot) {
    return { ok: false, message: '没有可回滚的迁移快照', view: snapshotView() }
  }
  const rolled = rollbackEngine(status.rollbackSnapshot)
  const stamp = status.lastCommitStamp ?? 'UNKNOWN'
  const next: MigrationStatus = {
    ...status,
    activeWriter: rolled.activeWriter,
    stage: 'ROLLED_BACK',
    locks: {},
    lastCommitStamp: status.lastCommitStamp,
    v2Configs: [],
    v2Index: [],
    audit: [
      ...status.audit,
      {
        at: nowIso,
        stage: 'ROLLED_BACK',
        commitStamp: stamp,
        message: '手动回滚完成：旧索引与已启用配置已恢复，写入版本回到 v1',
      } satisfies AuditEvent,
    ],
  }
  saveMigrationStatus(next)
  return {
    ok: true,
    message: '已恢复旧索引与已启用配置，写入版本回到 v1',
    view: {
      status: next,
      rebuildReport: null,
      manifest: loadManifest(),
      legacyIndexCount: rolled.legacyIndex.length,
    },
  }
}

/** 数据分发入口：按迁移侧同一提交戳读取清单（不传则读最近一次提交）。 */
export function readDistributionManifest(commitStamp?: string): {
  commitStamp: string | null
  items: DistributionManifestItem[]
} {
  const status = loadMigrationStatus()
  const stamp = commitStamp ?? status.lastCommitStamp
  if (!stamp) {
    return { commitStamp: null, items: [] }
  }
  const items = loadManifest().filter((item) => item.commitStamp === stamp)
  return { commitStamp: stamp, items }
}

/** 保留期视图：旧分区在当前时刻是否受保护，防止新规则提前删除。 */
export function retentionView(nowIso: string): {
  entry: V2IndexEntry
  protected: boolean
}[] {
  const { v2Index } = loadMigrationStatus()
  return v2Index.map((entry) => ({
    entry,
    protected: isPartitionProtected(entry, nowIso),
  }))
}

export function getMigrationView(): MigrationView {
  return snapshotView()
}

export function resetAll(): MigrationView {
  resetMigration()
  return snapshotView()
}

export { TARGET_ROOTS }
