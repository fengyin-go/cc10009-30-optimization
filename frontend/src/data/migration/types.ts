/**
 * 落盘任务升级（旧版 v1 → 新版 v2）迁移领域模型。
 *
 * 调用链：
 *   页面（views/storage、views/export）
 *     → api/migration-service.ts（动作编排、并发提交锁）
 *       → data/migration/migration-store.ts（localStorage 持久化）
 *       → data/migration/engine.ts（索引重建、配置迁移、保留期、回滚）
 */

/** 旧版（v1）批次索引条目。旧实现按「批次号」单键建索引，是本次要修的缺陷。 */
export type LegacyIndexEntry = {
  /** 旧批次号；旧索引的唯一键，同批次多分区时互相覆盖，产生重复/丢条目 */
  batchId: string
  /** 分区在旧根目录下的相对路径 */
  partitionPath: string
  /** 分区文件格式，随存储配置一起迁移 */
  fileFormat: string
  /** 分区策略（如按天 dt=、按小时 hr=） */
  partitionStrategy: string
  /** 旧批次结束时间（ISO），保留期从这个时刻起算 */
  batchEndAt: string
  /** 分区内容摘要，迁移前后必须一致 */
  digest: string
  /** 分区记录条数，用于迁移完整性校验 */
  rowCount: number
  sizeBytes: number
}

/** 旧版存储配置（对应 storage 模块里已启用的那一批配置行）。 */
export type LegacyStorageConfig = {
  configCode: string
  outputRoot: string
  fileFormat: string
  partitionStrategy: string
  retentionDays: number
  enabled: boolean
}

/** 新版（v2）存储配置：输出路径、文件格式、分区策略、保留天数全部随分区迁移。 */
export type V2StorageConfig = LegacyStorageConfig & {
  /** 迁移后的新根目录 */
  targetRoot: string
  /** 迁移提交戳，同一次提交的所有分区与分发清单共用 */
  commitStamp: string
  migratedAt: string
  schemaVersion: 2
}

/** 新版索引条目：复合键 (批次号, 分区路径)，修掉旧版单键覆盖缺陷。 */
export type V2IndexEntry = {
  /** 所属存储配置（目录）编号，同目录并发提交按它加锁 */
  configCode: string
  batchId: string
  partitionPath: string
  /** 迁移后的完整分区路径（新根 + 相对分区路径） */
  targetPath: string
  fileFormat: string
  partitionStrategy: string
  batchEndAt: string
  digest: string
  rowCount: number
  sizeBytes: number
  retentionDays: number
  /** 按旧批次结束时间算出的保留到期时刻 */
  expireAt: string
  commitStamp: string
}

/** 单个配置（目录）的迁移计划。 */
export type MigrationPlan = {
  configCode: string
  sourceRoot: string
  targetRoot: string
  fileFormat: string
  partitionStrategy: string
  retentionDays: number
  /** 该目录下待迁移的旧索引条目（已按批次+分区排序，保证确定性） */
  entries: LegacyIndexEntry[]
}

/** 迁移阶段，严格按顺序推进，任一阶段失败都不能切写入版本。 */
export type MigrationStage =
  | 'PLANNED'
  | 'INDEX_REBUILT'
  | 'BUILT'
  | 'DEPLOYED'
  | 'SWITCHED'
  | 'ROLLED_BACK'

export type MigrationStatus = {
  /** 当前写入版本：未切换前始终是 v1，全部成功后才是 v2 */
  activeWriter: 'v1' | 'v2'
  stage: MigrationStage
  /**
   * 同目录并发提交锁，按目录（配置编号）分别持有：
   * 同一目录第二个提交被拒绝；不同目录互不阻塞。为空表示没有进行中的提交。
   */
  locks: Record<string, { configCode: string; commitStamp: string; since: string }>
  /** 最近一次提交戳，数据分发清单按它读取 */
  lastCommitStamp: string | null
  plans: MigrationPlan[]
  v2Configs: V2StorageConfig[]
  v2Index: V2IndexEntry[]
  /** 回滚所需的旧索引与已启用配置快照 */
  rollbackSnapshot: {
    legacyIndex: LegacyIndexEntry[]
    legacyConfigs: LegacyStorageConfig[]
    activeWriter: 'v1' | 'v2'
    stage: MigrationStage
  } | null
  /** 阶段审计日志，便于页面展示与排障 */
  audit: AuditEvent[]
}

export type AuditEvent = {
  at: string
  stage: MigrationStage | 'LOCK' | 'LOCK_REJECTED' | 'FAILED'
  commitStamp: string
  message: string
}

/** 数据分发清单条目：另一个入口（export 模块）按同一提交戳读取。 */
export type DistributionManifestItem = {
  commitStamp: string
  configCode: string
  batchId: string
  targetPath: string
  fileFormat: string
  digest: string
  rowCount: number
  expireAt: string
}
