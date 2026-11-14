import { digestOf, isWithinRetention, retentionDeadline } from './digest'
import {
  LEGACY_CONFIGS,
  LEGACY_PARTITIONS,
  TARGET_ROOTS,
  type LegacyPartitionFile,
} from './legacy-seed'
import type {
  DistributionManifestItem,
  LegacyIndexEntry,
  LegacyStorageConfig,
  MigrationPlan,
  V2IndexEntry,
  V2StorageConfig,
} from './types'

/**
 * 迁移引擎：纯函数为主，浏览器与 Node 测试共用同一份实现。
 * 所有阶段都可重入、可校验，任何一步校验失败都抛错，由 service 层回滚。
 */

export type RebuildReport = {
  /** 旧索引条目数（含被覆盖丢失的问题） */
  legacyIndexCount: number
  /** 按复合键重建后的条目数 */
  rebuiltCount: number
  /** 旧索引缺失、被重建补回的分区键 */
  recoveredKeys: string[]
  /** 重建后是否仍存在重复复合键（正常应为 0） */
  duplicateCompositeKeys: string[]
}

export function compositeKey(batchId: string, partitionPath: string): string {
  return `${batchId}::${partitionPath}`
}

function toIndexEntry(file: LegacyPartitionFile): LegacyIndexEntry {
  const { configCode: _c, sourceRoot: _s, ...entry } = file
  void _c
  void _s
  return entry
}

/**
 * 顺着调用链定位批次索引问题：
 * 不直接信任旧索引，回到磁盘分区清单（LEGACY_PARTITIONS），以
 * (批次号, 分区路径) 复合键重建索引，修掉旧版按批次号单键覆盖的缺陷。
 */
export function rebuildBatchIndex(
  legacyIndex: LegacyIndexEntry[],
  files: LegacyPartitionFile[] = LEGACY_PARTITIONS,
): { entries: LegacyIndexEntry[]; report: RebuildReport } {
  const legacyKeys = new Set(
    legacyIndex.map((e) => compositeKey(e.batchId, e.partitionPath)),
  )
  const rebuilt = new Map<string, LegacyIndexEntry>()
  const duplicateCompositeKeys: string[] = []

  for (const file of files) {
    const entry = toIndexEntry(file)
    const key = compositeKey(entry.batchId, entry.partitionPath)
    if (rebuilt.has(key)) {
      // 同一复合键出现两条磁盘记录属于数据异常，不允许静默覆盖
      duplicateCompositeKeys.push(key)
      continue
    }
    rebuilt.set(key, entry)
  }

  const entries = [...rebuilt.values()].sort((a, b) => {
    const byBatch = a.batchId.localeCompare(b.batchId)
    return byBatch !== 0 ? byBatch : a.partitionPath.localeCompare(b.partitionPath)
  })

  const recoveredKeys = entries
    .map((e) => compositeKey(e.batchId, e.partitionPath))
    .filter((key) => !legacyKeys.has(key))

  return {
    entries,
    report: {
      legacyIndexCount: legacyIndex.length,
      rebuiltCount: entries.length,
      recoveredKeys,
      duplicateCompositeKeys,
    },
  }
}

/** 按配置（目录）生成迁移计划，并做确定性排序。 */
export function buildPlans(
  configs: LegacyStorageConfig[] = LEGACY_CONFIGS,
  files: LegacyPartitionFile[] = LEGACY_PARTITIONS,
  targets: Record<string, string> = TARGET_ROOTS,
): MigrationPlan[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => {
      const targetRoot = targets[config.configCode]
      if (!targetRoot) {
        throw new Error(`配置 ${config.configCode} 缺少迁移目标目录`)
      }
      const entries = files
        .filter(
          (file) =>
            file.configCode === config.configCode && file.sourceRoot === config.outputRoot,
        )
        .map(toIndexEntry)
        .sort((a, b) => {
          const byBatch = a.batchId.localeCompare(b.batchId)
          return byBatch !== 0 ? byBatch : a.partitionPath.localeCompare(b.partitionPath)
        })
      if (entries.length === 0) {
        throw new Error(`配置 ${config.configCode} 在 ${config.outputRoot} 下没有可迁移分区`)
      }
      return {
        configCode: config.configCode,
        sourceRoot: config.outputRoot,
        targetRoot,
        fileFormat: config.fileFormat,
        partitionStrategy: config.partitionStrategy,
        retentionDays: config.retentionDays,
        entries,
      }
    })
    .sort((a, b) => a.configCode.localeCompare(b.configCode))
}

export type BuiltMigration = {
  v2Configs: V2StorageConfig[]
  v2Index: V2IndexEntry[]
}

/**
 * 构建阶段：把存储配置（输出路径、文件格式、分区策略、保留天数）随历史
 * 分区一起迁到 v2，并按旧批次结束时间计算每条分区的保留到期时刻。
 * 此阶段只产出新结构，不改写入版本。
 */
export function buildMigration(
  plans: MigrationPlan[],
  commitStamp: string,
  nowIso: string,
): BuiltMigration {
  const v2Configs: V2StorageConfig[] = []
  const v2Index: V2IndexEntry[] = []

  for (const plan of plans) {
    const legacyConfig = LEGACY_CONFIGS.find((c) => c.configCode === plan.configCode)
    if (!legacyConfig) {
      throw new Error(`构建失败：找不到旧配置 ${plan.configCode}`)
    }
    // 四项关键存储配置逐项随迁，任何一项漂移都在 validateBuild 里拦截
    v2Configs.push({
      ...legacyConfig,
      outputRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      fileFormat: plan.fileFormat,
      partitionStrategy: plan.partitionStrategy,
      retentionDays: plan.retentionDays,
      commitStamp,
      migratedAt: nowIso,
      schemaVersion: 2,
    })

    for (const entry of plan.entries) {
      if (entry.fileFormat !== plan.fileFormat) {
        throw new Error(
          `构建失败：分区 ${entry.partitionPath} 文件格式与配置不一致，拒绝静默改格式`,
        )
      }
      if (entry.partitionStrategy !== plan.partitionStrategy) {
        throw new Error(`构建失败：分区 ${entry.partitionPath} 分区策略与配置不一致`)
      }
      v2Index.push({
        configCode: plan.configCode,
        batchId: entry.batchId,
        partitionPath: entry.partitionPath,
        targetPath: `${plan.targetRoot}/${entry.partitionPath}`,
        fileFormat: entry.fileFormat,
        partitionStrategy: entry.partitionStrategy,
        batchEndAt: entry.batchEndAt,
        digest: entry.digest,
        rowCount: entry.rowCount,
        sizeBytes: entry.sizeBytes,
        retentionDays: plan.retentionDays,
        // 保留期按旧批次结束时间执行，迁移不重置起算时刻
        expireAt: retentionDeadline(entry.batchEndAt, plan.retentionDays),
        commitStamp,
      })
    }
  }

  validateBuild(plans, { v2Configs, v2Index })
  return { v2Configs, v2Index }
}

/** 构建校验：配置四要素随迁、条目数量、摘要、保留天数全部对齐。 */
export function validateBuild(plans: MigrationPlan[], built: BuiltMigration): void {
  let plannedEntries = 0
  for (const plan of plans) {
    plannedEntries += plan.entries.length
    const config = built.v2Configs.find((c) => c.configCode === plan.configCode)
    if (!config) {
      throw new Error(`构建校验失败：缺少 v2 配置 ${plan.configCode}`)
    }
    if (config.fileFormat !== plan.fileFormat) throw new Error('构建校验失败：文件格式漂移')
    if (config.partitionStrategy !== plan.partitionStrategy) {
      throw new Error('构建校验失败：分区策略漂移')
    }
    if (config.retentionDays !== plan.retentionDays) {
      throw new Error('构建校验失败：保留天数漂移')
    }
    if (config.targetRoot !== plan.targetRoot) {
      throw new Error('构建校验失败：输出路径漂移')
    }
  }
  if (built.v2Index.length !== plannedEntries) {
    throw new Error(
      `构建校验失败：索引条目数 ${built.v2Index.length} 与计划分区数 ${plannedEntries} 不一致`,
    )
  }
  // 摘要逐条比对：迁移不得改变摘要
  for (const plan of plans) {
    for (const entry of plan.entries) {
      const moved = built.v2Index.find(
        (v2) =>
          v2.configCode === plan.configCode &&
          v2.batchId === entry.batchId &&
          v2.partitionPath === entry.partitionPath &&
          v2.commitStamp === configCommitStamp(built, plan.configCode),
      )
      if (!moved) {
        throw new Error(`构建校验失败：分区 ${entry.partitionPath} 在新索引中缺失`)
      }
      if (moved.digest !== entry.digest || moved.rowCount !== entry.rowCount) {
        throw new Error(`构建校验失败：分区 ${entry.partitionPath} 摘要或条数被改变`)
      }
      if (moved.expireAt !== retentionDeadline(entry.batchEndAt, plan.retentionDays)) {
        throw new Error('构建校验失败：保留期未按旧批次结束时间计算')
      }
    }
  }
}

function configCommitStamp(built: BuiltMigration, configCode: string): string {
  const config = built.v2Configs.find((c) => c.configCode === configCode)
  if (!config) {
    throw new Error(`内部错误：配置 ${configCode} 缺少提交戳`)
  }
  return config.commitStamp
}

/**
 * 部署校验：新索引必须无重复复合键、目标路径不与旧目录冲突、
 * 全部条目归属与目录一致。通过后才允许切换写入版本。
 */
export function validateDeployment(built: BuiltMigration): void {
  const keys = new Set<string>()
  for (const entry of built.v2Index) {
    const key = compositeKey(entry.batchId, entry.partitionPath)
    if (keys.has(key)) {
      throw new Error(`部署失败：新索引仍存在重复批次分区键 ${key}`)
    }
    keys.add(key)
    if (!entry.targetPath.startsWith('/archive/')) {
      throw new Error(`部署失败：目标路径 ${entry.targetPath} 不在归档根下，拒绝覆盖旧目录`)
    }
    const owner = built.v2Configs.find(
      (c) => c.configCode === entry.configCode && c.commitStamp === entry.commitStamp,
    )
    if (!owner || !entry.targetPath.startsWith(owner.targetRoot)) {
      throw new Error(`部署失败：分区 ${entry.partitionPath} 与所属配置目录不一致`)
    }
  }
}

/**
 * 生成数据分发清单：只收录本次提交戳的分区，供 export 入口读取。
 * 另一个入口拿到的提交戳必须与迁移侧完全一致。
 */
export function buildDistributionManifest(
  v2Index: V2IndexEntry[],
  commitStamp: string,
): DistributionManifestItem[] {
  return v2Index
    .filter((entry) => entry.commitStamp === commitStamp)
    .map((entry) => ({
      commitStamp: entry.commitStamp,
      configCode: entry.configCode,
      batchId: entry.batchId,
      targetPath: entry.targetPath,
      fileFormat: entry.fileFormat,
      digest: entry.digest,
      rowCount: entry.rowCount,
      expireAt: entry.expireAt,
    }))
    .sort((a, b) =>
      a.configCode === b.configCode
        ? a.targetPath.localeCompare(b.targetPath)
        : a.configCode.localeCompare(b.configCode),
    )
}

/** 保留期判断：旧分区是否仍受保护，新规则不能提前删除。 */
export function isPartitionProtected(entry: V2IndexEntry, nowIso: string): boolean {
  return isWithinRetention(entry.expireAt, nowIso)
}

/** 整个迁移产物的摘要：回滚后与再次构建应得到相同结果（确定性证据）。 */
export function migrationDigest(built: BuiltMigration): string {
  return digestOf({ configs: built.v2Configs, index: built.v2Index })
}

/**
 * 回滚：恢复旧索引与已启用配置，写入版本切回 v1。
 * 返回可直接落盘的旧版状态；旧分区文件由调用方保证未被新规则删除
 * （保留期校验在切换前已拦截）。
 */
export function rollback(snapshot: {
  legacyIndex: LegacyIndexEntry[]
  legacyConfigs: LegacyStorageConfig[]
}): {
  activeWriter: 'v1'
  legacyIndex: LegacyIndexEntry[]
  legacyConfigs: LegacyStorageConfig[]
} {
  return {
    activeWriter: 'v1',
    legacyIndex: snapshot.legacyIndex.map((e) => ({ ...e })),
    legacyConfigs: snapshot.legacyConfigs.map((c) => ({ ...c })),
  }
}
