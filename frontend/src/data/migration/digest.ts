/**
 * 迁移工具：确定性摘要与时间计算。
 *
 * 纯前端环境没有文件系统，这里的「分区文件」是数据层里的记录，但迁移语义
 * （摘要不变、保留期按旧批次结束时间算）与真实文件迁移保持一致，并且所有
 * 计算都是确定性的，Node 测试脚本与浏览器里跑出的结果必须完全相同。
 */

/** FNV-1a 32 位哈希：实现简单、零依赖，浏览器与 Node 结果一致。 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // 32 位无符号乘法，Math.imul 保证 Node/浏览器行为一致
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 规范化 JSON：对象键排序后序列化，避免键顺序导致摘要抖动。 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input
    }
    if (seen.has(input as object)) {
      throw new Error('规范化摘要不支持循环引用')
    }
    seen.add(input as object)
    if (Array.isArray(input)) {
      return input.map(normalize)
    }
    const record = input as Record<string, unknown>
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalize(record[key])
        return acc
      }, {})
  }
  return JSON.stringify(normalize(value))
}

/** 对任意可序列化内容计算确定性摘要。 */
export function digestOf(value: unknown): string {
  return fnv1a32(canonicalJson(value))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 保留期到期时刻 = 旧批次结束时间 + 保留天数（按天取整）。 */
export function retentionDeadline(batchEndAt: string, retentionDays: number): string {
  const end = new Date(batchEndAt).getTime()
  if (Number.isNaN(end)) {
    throw new Error(`无法解析批次结束时间：${batchEndAt}`)
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(`保留天数必须是非负整数：${retentionDays}`)
  }
  return new Date(end + retentionDays * DAY_MS).toISOString()
}

/** 给定当前时刻，分区是否仍在保留期内。 */
export function isWithinRetention(deadline: string, nowIso: string): boolean {
  return new Date(deadline).getTime() > new Date(nowIso).getTime()
}
