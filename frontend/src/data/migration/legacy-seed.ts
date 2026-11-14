import type {
  DistributionManifestItem,
  LegacyIndexEntry,
  LegacyStorageConfig,
} from './types'

/**
 * 旧版（v1）落盘任务的真实数据夹具，模拟磁盘上的分区与旧批次索引。
 *
 * 旧索引缺陷：旧实现以「批次号」为唯一键构建索引。当同一个批次在同一目录
 * 下产出多个分区（STOR-7 的 B 批次有 dt=11 与 dt=12 两个 CSV 分区）时，
 * 后写入的分区会覆盖先写入的，旧索引因此丢条目。迁移时必须顺着调用链
 * 回到原始分区清单重建，而不能直接信任旧索引。
 */

export type LegacyPartitionFile = LegacyIndexEntry & {
  /** 分区所在配置（目录）编号 */
  configCode: string
  sourceRoot: string
}

const STOR7_PARTITIONS: LegacyPartitionFile[] = [
  {
    configCode: 'STOR-7',
    sourceRoot: '/collect/a',
    batchId: 'B20261112',
    partitionPath: 'dt=2026-11-12/part-0.csv',
    fileFormat: 'CSV',
    partitionStrategy: '按天分区(dt=yyyy-MM-dd)',
    batchEndAt: '2026-11-13T08:10:00.000Z',
    digest: 'a17c9f02',
    rowCount: 1280,
    sizeBytes: 98234,
  },
  {
    configCode: 'STOR-7',
    sourceRoot: '/collect/a',
    batchId: 'B20261113',
    partitionPath: 'dt=2026-11-13/part-0.csv',
    fileFormat: 'CSV',
    partitionStrategy: '按天分区(dt=yyyy-MM-dd)',
    batchEndAt: '2026-11-13T08:10:00.000Z',
    digest: 'b28d1047',
    rowCount: 960,
    sizeBytes: 74110,
  },
  {
    configCode: 'STOR-7',
    sourceRoot: '/collect/a',
    batchId: 'B20261113',
    partitionPath: 'dt=2026-11-13/part-1.csv',
    fileFormat: 'CSV',
    partitionStrategy: '按天分区(dt=yyyy-MM-dd)',
    batchEndAt: '2026-11-13T08:10:00.000Z',
    digest: 'c39e25a8',
    rowCount: 412,
    sizeBytes: 31877,
  },
]

const STOR3_PARTITIONS: LegacyPartitionFile[] = [
  {
    configCode: 'STOR-3',
    sourceRoot: '/collect/c',
    batchId: 'B20261110',
    partitionPath: 'hr=10/part-0.json',
    fileFormat: 'JSON',
    partitionStrategy: '按小时分区(hr=HH)',
    batchEndAt: '2026-11-10T11:00:00.000Z',
    digest: 'd4af36be',
    rowCount: 540,
    sizeBytes: 40211,
  },
]

/** 磁盘上实际存在的全部分区（迁移的事实来源，旧索引可能比它少）。 */
export const LEGACY_PARTITIONS: LegacyPartitionFile[] = [
  ...STOR7_PARTITIONS,
  ...STOR3_PARTITIONS,
]

/**
 * 旧版批次索引：直接复刻「按批次号单键 Map」的错误结果。
 * STOR-7 的 B20261113 批次有两个分区，旧索引只留下最后写入的 part-1，
 * dt=2026-11-13/part-0 被覆盖丢失——这就是要定位并修掉的批次索引问题。
 */
export function buildLegacyIndex(): LegacyIndexEntry[] {
  const byBatch = new Map<string, LegacyIndexEntry>()
  for (const file of LEGACY_PARTITIONS) {
    const { configCode: _configCode, sourceRoot: _sourceRoot, ...entry } = file
    void _configCode
    void _sourceRoot
    // 旧实现：batchId 单键覆盖
    byBatch.set(entry.batchId, entry)
  }
  return [...byBatch.values()].sort((a, b) => a.batchId.localeCompare(b.batchId))
}

/** 旧版已启用存储配置。 */
export const LEGACY_CONFIGS: LegacyStorageConfig[] = [
  {
    configCode: 'STOR-7',
    outputRoot: '/collect/a',
    fileFormat: 'CSV',
    partitionStrategy: '按天分区(dt=yyyy-MM-dd)',
    retentionDays: 14,
    enabled: true,
  },
  {
    configCode: 'STOR-3',
    outputRoot: '/collect/c',
    fileFormat: 'JSON',
    partitionStrategy: '按小时分区(hr=HH)',
    retentionDays: 7,
    enabled: true,
  },
]

/** 迁移目标目录：旧 CSV 分区从 /collect/a 迁到 /archive/b。 */
export const TARGET_ROOTS: Record<string, string> = {
  'STOR-7': '/archive/b',
  'STOR-3': '/archive/c',
}

/**
 * 另一个入口（数据分发 export）登记的分发清单。
 * 清单不自己保存提交戳，读取时按迁移侧最近一次提交戳过滤。
 */
export const SEED_DISTRIBUTION_MANIFEST: DistributionManifestItem[] = [
  {
    commitStamp: 'PRE_MIGRATION',
    configCode: 'STOR-7',
    batchId: 'B20261112',
    targetPath: '/collect/a/dt=2026-11-12/part-0.csv',
    fileFormat: 'CSV',
    digest: 'a17c9f02',
    rowCount: 1280,
    expireAt: '2026-11-27T08:10:00.000Z',
  },
]
