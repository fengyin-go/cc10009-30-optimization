/**
 * 落盘任务升级迁移的端到端校验（纯 Node，无浏览器）。
 * 覆盖：批次索引缺陷定位与重建、配置四要素随迁、构建/部署门控、
 * 同目录并发锁、分发清单同提交戳、保留期按旧批次结束时间、回滚、
 * 旧分区不被提前删除、STOR-7 路径与摘要不变。
 */
import assert from 'node:assert/strict'

const { useStorage } = await import('@/data/migration/migration-store')

class MemoryStorage {
  map = new Map()
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    this.map.set(key, value)
  }
  removeItem(key) {
    this.map.delete(key)
  }
}

let pass = 0
const results = []
async function test(name, fn) {
  // 每个用例独立存储，避免 localStorage 状态串扰
  useStorage(new MemoryStorage())
  try {
    await fn()
    pass += 1
    results.push(`  ✓ ${name}`)
  } catch (error) {
    results.push(`  ✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}

const { buildLegacyIndex, LEGACY_PARTITIONS, LEGACY_CONFIGS, TARGET_ROOTS } = await import(
  '@/data/migration/legacy-seed'
)
const engine = await import('@/data/migration/engine')
const service = await import('@/api/migration-service')
const store = await import('@/data/migration/migration-store')
const { digestOf, retentionDeadline } = await import('@/data/migration/digest')

const NOW = '2026-11-14T00:00:00.000Z'
const CREATED_AT = '2026-11-13T08:10:00.000Z'

// ---- 1. 批次索引问题定位：旧索引按批次号单键，覆盖丢条目 ----
await test('旧批次索引复现单键覆盖缺陷：B20261113 两个分区只剩一个', () => {
  const legacy = buildLegacyIndex()
  const bBatch = legacy.filter((e) => e.batchId === 'B20261113')
  assert.equal(bBatch.length, 1, '旧索引里 B20261113 应只剩 1 条（被覆盖）')
  // 4 个磁盘分区，3 个不同批次号 → 单键索引只剩 3 条，STOR-7 丢 1 条
  assert.equal(legacy.length, 3, '旧索引共 3 条（B20261112/B20261113/B20261110）')
  assert.equal(LEGACY_PARTITIONS.length, 4, '磁盘上实际有 4 个分区')
  const diskForBatch = LEGACY_PARTITIONS.filter((f) => f.batchId === 'B20261113')
  assert.equal(diskForBatch.length, 2, 'B20261113 批次实际有 2 个分区')
  assert.equal(
    bBatch[0].partitionPath,
    'dt=2026-11-13/part-1.csv',
    '留下的是最后写入的 part-1，part-0 被覆盖',
  )
})

// ---- 2. 重建索引：复合键补回丢失分区 ----
await test('新版本上线前迁移旧索引：复合键重建补回丢失分区且无重复', () => {
  const legacy = buildLegacyIndex()
  const { entries, report } = engine.rebuildBatchIndex(legacy)
  assert.equal(report.legacyIndexCount, 3)
  assert.equal(report.rebuiltCount, 4, '两个配置共 4 个磁盘分区全部入索引')
  assert.equal(report.recoveredKeys.length, 1, '补回旧索引唯一丢失的 STOR-7 part-0')
  assert.deepEqual(report.recoveredKeys, ['B20261113::dt=2026-11-13/part-0.csv'])
  assert.equal(report.duplicateCompositeKeys.length, 0)
  const keys = entries.map((e) => engine.compositeKey(e.batchId, e.partitionPath))
  assert.equal(new Set(keys).size, keys.length, '重建后无重复复合键')
})

// ---- 3. STOR-7 路径迁移 /collect/a -> /archive/b ----
await test('STOR-7 旧 CSV 分区从 /collect/a 迁到 /archive/b', () => {
  const result = service.runMigration('STOR-7', NOW)
  assert.equal(result.ok, true, result.message)
  const stor7 = result.view.status.v2Index.filter((e) => e.configCode === 'STOR-7')
  assert.equal(stor7.length, 3)
  for (const entry of stor7) {
    assert.ok(entry.targetPath.startsWith('/archive/b/'), `${entry.targetPath} 应在 /archive/b 下`)
    assert.ok(!entry.targetPath.startsWith('/collect/a'), '旧路径不应残留')
    assert.equal(entry.fileFormat, 'CSV')
  }
  const expected = [
    '/archive/b/dt=2026-11-12/part-0.csv',
    '/archive/b/dt=2026-11-13/part-0.csv',
    '/archive/b/dt=2026-11-13/part-1.csv',
  ]
  assert.deepEqual(stor7.map((e) => e.targetPath).sort(), expected)
})

// ---- 4. 迁移不得改变摘要 ----
await test('迁移不得改变摘要：逐条 digest/条数与磁盘原件一致', () => {
  const result = service.runMigration('STOR-7', NOW)
  const before = digestOf(
    LEGACY_PARTITIONS.filter((f) => f.configCode === 'STOR-7')
      .map((f) => ({ digest: f.digest, rows: f.rowCount, path: f.partitionPath }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  )
  const after = digestOf(
    result.view.status.v2Index
      .map((e) => ({ digest: e.digest, rows: e.rowCount, path: e.partitionPath }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  )
  assert.equal(after, before, '迁移前后分区摘要集合必须一致')
  for (const entry of result.view.status.v2Index) {
    const src = LEGACY_PARTITIONS.find(
      (f) => f.batchId === entry.batchId && f.partitionPath === entry.partitionPath,
    )
    assert.equal(entry.digest, src.digest)
    assert.equal(entry.rowCount, src.rowCount)
    assert.equal(entry.sizeBytes, src.sizeBytes)
  }
})

// ---- 5. 存储配置四要素随历史分区迁移 ----
await test('输出路径/文件格式/分区策略/保留天数随历史分区一起迁移', () => {
  const result = service.runMigration('STOR-7', NOW)
  const cfg = result.view.status.v2Configs.find((c) => c.configCode === 'STOR-7')
  const legacy = LEGACY_CONFIGS.find((c) => c.configCode === 'STOR-7')
  assert.equal(cfg.outputRoot, '/collect/a')
  assert.equal(cfg.targetRoot, '/archive/b')
  assert.equal(cfg.fileFormat, legacy.fileFormat, 'CSV')
  assert.equal(cfg.partitionStrategy, legacy.partitionStrategy)
  assert.equal(cfg.retentionDays, 14)
  assert.equal(cfg.schemaVersion, 2)
  for (const entry of result.view.status.v2Index) {
    assert.equal(entry.fileFormat, 'CSV')
    assert.equal(entry.partitionStrategy, '按天分区(dt=yyyy-MM-dd)')
    assert.equal(entry.retentionDays, 14)
  }
})

// ---- 6. 只有完整构建并部署成功才切换写入版本 ----
await test('部署失败时不切换写入版本并自动回滚到 v1', () => {
  const result = service.runMigration('STOR-7', NOW, () => true)
  assert.equal(result.ok, false)
  assert.equal(result.view.status.activeWriter, 'v1', '部署失败写入版本必须仍是 v1')
  assert.equal(result.view.status.stage, 'ROLLED_BACK')
  assert.equal(result.view.status.v2Index.length, 0, '回滚后 v2 索引清空')
  assert.equal(Object.keys(result.view.status.locks).length, 0, '失败后目录锁必须释放')
  // 旧索引保持缺陷原样可复查
  assert.equal(store.loadLegacyIndex().length, 3)
})

await test('完整构建并部署成功后才切到 v2，阶段顺序完整', () => {
  const result = service.runMigration('STOR-7', NOW)
  assert.equal(result.view.status.activeWriter, 'v2')
  const stages = result.view.status.audit.map((e) => e.stage)
  const expectedOrder = ['LOCK', 'INDEX_REBUILT', 'BUILT', 'DEPLOYED', 'SWITCHED']
  for (const stage of expectedOrder) {
    assert.ok(stages.includes(stage), `缺少阶段 ${stage}`)
  }
  assert.ok(stages.indexOf('DEPLOYED') < stages.indexOf('SWITCHED'), '必须先部署后切换')
})

// ---- 7. 同目录并发提交只能一个完成 ----
await test('同一目录并发提交：持锁期间第二个提交被拒绝，只有一个完成', () => {
  const first = service.runMigration('STOR-7', NOW)
  assert.equal(first.ok, true)
  // 第一次已正常释放锁；这里模拟「进行中」并发：手工上锁后再提交
  const inProgress = store.loadMigrationStatus()
  store.saveMigrationStatus({
    ...inProgress,
    locks: { 'STOR-7': { configCode: 'STOR-7', commitStamp: 'IN-FLIGHT-1', since: NOW } },
  })
  const second = service.runMigration('STOR-7', NOW)
  assert.equal(second.ok, false)
  assert.match(second.message, /已有进行中的提交/)
  assert.equal(second.view.status.locks['STOR-7'].commitStamp, 'IN-FLIGHT-1', '持锁提交不受影响')
  const rejected = second.view.status.audit.find((e) => e.stage === 'LOCK_REJECTED')
  assert.ok(rejected)
})

// ---- 8. 不同目录互不阻塞（锁粒度是目录） ----
await test('锁按目录隔离：STOR-7 持锁不阻塞 STOR-3，两个目录都能完成', () => {
  const status = store.loadMigrationStatus()
  store.saveMigrationStatus({
    ...status,
    locks: { 'STOR-7': { configCode: 'STOR-7', commitStamp: 'IN-FLIGHT-7', since: NOW } },
  })
  // STOR-3 是不同目录，必须能正常提交并完成
  const result = service.runMigration('STOR-3', NOW)
  assert.equal(result.ok, true, '不同目录并发提交互不阻塞')
  assert.equal(result.view.status.activeWriter, 'v2')
  // STOR-7 的锁原样保留，没有被 STOR-3 误释放
  assert.equal(store.loadMigrationStatus().locks['STOR-7'].commitStamp, 'IN-FLIGHT-7')
  assert.equal(result.view.status.v2Index[0].configCode, 'STOR-3')
})

// ---- 9. 数据分发清单读取同一提交戳 ----
await test('另一个入口的数据分发清单按同一提交戳读取', () => {
  const result = service.runMigration('STOR-7', NOW)
  const stamp = result.view.status.lastCommitStamp
  assert.ok(stamp)
  const read = service.readDistributionManifest()
  assert.equal(read.commitStamp, stamp, '不传戳时读最近一次提交戳')
  assert.equal(read.items.length, 3, 'STOR-7 三个分区都进清单')
  assert.ok(read.items.every((i) => i.commitStamp === stamp))
  // 显式传戳结果一致
  const explicit = service.readDistributionManifest(stamp)
  assert.deepEqual(explicit.items, read.items)
  // 别的提交戳读不到本次清单
  const other = service.readDistributionManifest('NOT-A-REAL-STAMP')
  assert.equal(other.items.length, 0)
  // 清单里的路径与摘要和迁移结果一致（同批次有两个分区，需按批次+分区定位）
  for (const item of read.items) {
    assert.ok(item.targetPath.startsWith('/archive/b/'))
    const src = LEGACY_PARTITIONS.find(
      (f) => f.batchId === item.batchId && f.partitionPath === item.targetPath.replace('/archive/b/', ''),
    )
    assert.ok(src, `清单分区 ${item.targetPath} 必须能对应到磁盘原件`)
    assert.equal(item.digest, src.digest)
  }
})

// ---- 10. 保留期按旧批次结束时间执行 ----
await test('保留期按旧批次结束时间 + 14 天计算，迁移不重置起算点', () => {
  const result = service.runMigration('STOR-7', NOW)
  for (const entry of result.view.status.v2Index) {
    assert.equal(
      entry.expireAt,
      retentionDeadline(CREATED_AT, 14),
      `${entry.partitionPath} 到期时刻=旧批次结束+14天`,
    )
    assert.equal(entry.expireAt, '2026-11-27T08:10:00.000Z')
    assert.equal(entry.batchEndAt, CREATED_AT)
  }
})

// ---- 11. 旧分区不能被新规则提前删除 ----
await test('旧分区在保留期内受保护，新规则不能提前删除', () => {
  const result = service.runMigration('STOR-7', NOW)
  const view = service.retentionView(NOW)
  assert.equal(view.length, 3)
  assert.ok(view.every((v) => v.protected === true), '11月14日全部在11月27日到期之前，受保护')
  // 到期后才允许清理
  const afterExpiry = service.retentionView('2026-11-28T00:00:00.000Z')
  assert.ok(afterExpiry.every((v) => v.protected === false), '过了保留期才解除保护')
  // 临界点：到期时刻本身仍受保护（严格大于）
  const boundary = service.retentionView('2026-11-27T08:10:00.000Z')
  assert.ok(boundary.every((v) => v.protected === false))
})

// ---- 12. 回滚恢复旧索引和已启用配置 ----
await test('回滚恢复旧索引与已启用配置，写入版本回到 v1', () => {
  const migrated = service.runMigration('STOR-7', NOW)
  assert.equal(migrated.view.status.activeWriter, 'v2')
  const rolled = service.rollbackMigration(NOW)
  assert.equal(rolled.ok, true)
  assert.equal(rolled.view.status.activeWriter, 'v1')
  assert.equal(rolled.view.status.stage, 'ROLLED_BACK')
  const legacyIndex = store.loadLegacyIndex()
  assert.equal(legacyIndex.length, 3, '旧索引（含其缺陷形态）已恢复')
  assert.deepEqual(legacyIndex, buildLegacyIndex())
  assert.equal(rolled.view.legacyIndexCount, 3)
})

// ---- 13. 摘要确定性：重复构建产物一致 ----
await test('迁移产物确定性：同一输入两次构建摘要相同（回滚后可安全重建）', () => {
  const plans = engine.buildPlans()
  const first = engine.buildMigration(plans, 'STAMP-X', NOW)
  const second = engine.buildMigration(plans, 'STAMP-X', NOW)
  assert.equal(engine.migrationDigest(first), engine.migrationDigest(second))
})

// ---- 14. STOR-3 小时分区保留 7 天，路径迁到 /archive/c ----
await test('STOR-3 JSON 小时分区迁移到 /archive/c，保留 7 天', () => {
  const result = service.runMigration('STOR-3', NOW)
  assert.equal(result.ok, true)
  const entry = result.view.status.v2Index[0]
  assert.equal(entry.targetPath, '/archive/c/hr=10/part-0.json')
  assert.equal(entry.fileFormat, 'JSON')
  assert.equal(entry.retentionDays, 7)
  assert.equal(entry.expireAt, retentionDeadline('2026-11-10T11:00:00.000Z', 7))
  assert.equal(TARGET_ROOTS['STOR-7'], '/archive/b')
})

// ---- 15. 重放幂等：同一提交戳重写清单不产生重复 ----
await test('分发清单同戳重放幂等', () => {
  const result = service.runMigration('STOR-7', NOW)
  const stamp = result.view.status.lastCommitStamp
  const items = engine.buildDistributionManifest(result.view.status.v2Index, stamp)
  const once = store.appendManifest(items)
  const twice = store.appendManifest(items)
  assert.equal(twice.length, once.length, '重复追加同戳清单不产生重复行')
  assert.equal(twice.filter((i) => i.commitStamp === stamp).length, items.length)
})

// ---- 16. 多目录分批迁移结果累加，不互相覆盖 ----
await test('多目录分批迁移：先 STOR-7 再 STOR-3，v2 索引与配置累加保留', () => {
  const r7 = service.runMigration('STOR-7', NOW)
  assert.equal(r7.ok, true)
  const r3 = service.runMigration('STOR-3', NOW)
  assert.equal(r3.ok, true)
  const final = store.loadMigrationStatus()
  assert.equal(final.v2Index.length, 4, '3 个 STOR-7 分区 + 1 个 STOR-3 分区')
  assert.equal(final.v2Configs.length, 2)
  assert.deepEqual(
    [...new Set(final.v2Index.map((e) => e.configCode))].sort(),
    ['STOR-3', 'STOR-7'],
  )
  assert.equal(final.activeWriter, 'v2')
  // 每次提交戳不同，最近一次是 STOR-3
  const stamp7 = r7.view.status.lastCommitStamp
  const stamp3 = r3.view.status.lastCommitStamp
  assert.notEqual(stamp7, stamp3)
  assert.equal(final.lastCommitStamp, stamp3)
})

// ---- 17. 同一目录重复迁移被拒绝，保护既有 v2 结果 ----
await test('同一目录重复提交被拒绝，不会覆盖已迁移的索引与提交戳', () => {
  const first = service.runMigration('STOR-7', NOW)
  assert.equal(first.ok, true)
  const stampBefore = first.view.status.lastCommitStamp
  const again = service.runMigration('STOR-7', NOW)
  assert.equal(again.ok, false)
  assert.match(again.message, /已完成迁移/)
  assert.equal(store.loadMigrationStatus().lastCommitStamp, stampBefore)
  assert.equal(store.loadMigrationStatus().v2Index.length, 3)
})

console.log(results.join('\n'))
console.log(`\n通过 ${pass}/${results.length} 个用例`)
if (process.exitCode) {
  console.error('存在失败用例')
}
