import {
  SEED_DISTRIBUTION_MANIFEST,
  buildLegacyIndex,
  LEGACY_CONFIGS,
} from './legacy-seed'
import type {
  DistributionManifestItem,
  LegacyIndexEntry,
  MigrationStatus,
  MigrationStage,
} from './types'

/**
 * 迁移状态持久化。
 *
 * 浏览器里落在 localStorage（与业务数据的 scraper-config-studio:entries
 * 分开存，避免互相污染）；Node 测试通过注入内存 storage 跑同一套代码。
 */

const MIGRATION_KEY = 'scraper-config-studio:storage-migration'
const MANIFEST_KEY = 'scraper-config-studio:distribution-manifest'
const LEGACY_INDEX_KEY = 'scraper-config-studio:legacy-batch-index'

export type SimpleStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 进程内可注入的存储；默认取浏览器 localStorage，测试里换成内存实现。 */
let injected: SimpleStorage | null = null

class MemoryStorage implements SimpleStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

function resolveStorage(): SimpleStorage {
  if (injected) {
    return injected
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  // 非浏览器环境（Node 测试）退回到模块级内存存储，保证逻辑可跑
  injected = new MemoryStorage()
  return injected
}

/** 测试入口：替换存储实现，返回还原函数。 */
export function useStorage(next: SimpleStorage): () => void {
  const previous = injected
  injected = next
  return () => {
    injected = previous
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = resolveStorage().getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  resolveStorage().setItem(key, JSON.stringify(value))
}

/** 旧批次索引：首次访问时按旧实现（单键 Map）播种，确保缺陷可复现。 */
export function loadLegacyIndex(): LegacyIndexEntry[] {
  const cached = readJson<LegacyIndexEntry[] | null>(LEGACY_INDEX_KEY, null)
  if (cached) {
    return cached
  }
  const seeded = buildLegacyIndex()
  writeJson(LEGACY_INDEX_KEY, seeded)
  return seeded
}

function initialStatus(): MigrationStatus {
  return {
    activeWriter: 'v1',
    stage: 'PLANNED',
    locks: {},
    lastCommitStamp: null,
    plans: [],
    v2Configs: [],
    v2Index: [],
    rollbackSnapshot: null,
    audit: [],
  }
}

export function loadMigrationStatus(): MigrationStatus {
  const status = readJson<MigrationStatus | null>(MIGRATION_KEY, null)
  if (!status) {
    return initialStatus()
  }
  // 崩溃恢复：遗留的锁需要人工/重试介入，这里保留锁信息但不自动清
  return status
}

export function saveMigrationStatus(status: MigrationStatus): void {
  writeJson(MIGRATION_KEY, status)
}

export function resetMigration(): MigrationStatus {
  const storage = resolveStorage()
  storage.removeItem(MIGRATION_KEY)
  storage.removeItem(LEGACY_INDEX_KEY)
  storage.removeItem(MANIFEST_KEY)
  return initialStatus()
}

export function appendAudit(
  status: MigrationStatus,
  stage: MigrationStage | 'LOCK' | 'LOCK_REJECTED' | 'FAILED',
  commitStamp: string,
  message: string,
  nowIso: string,
): MigrationStatus {
  return {
    ...status,
    audit: [...status.audit, { at: nowIso, stage, commitStamp, message }],
  }
}

/** 数据分发清单：迁移提交后追加；读取方按提交戳过滤。 */
export function loadManifest(): DistributionManifestItem[] {
  return readJson<DistributionManifestItem[]>(MANIFEST_KEY, [
    ...SEED_DISTRIBUTION_MANIFEST,
  ])
}

export function appendManifest(items: DistributionManifestItem[]): DistributionManifestItem[] {
  const current = loadManifest()
  // 同一提交戳重放时幂等：先剔除同戳旧条目再写入
  const stamps = new Set(items.map((item) => item.commitStamp))
  const merged = [...current.filter((item) => !stamps.has(item.commitStamp)), ...items]
  writeJson(MANIFEST_KEY, merged)
  return merged
}

/** 供测试与页面展示：旧版已启用配置快照来源。 */
export { LEGACY_CONFIGS }
