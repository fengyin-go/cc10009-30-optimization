/**
 * Node ESM resolve 钩子：
 *  1. 把业务源码里的 '@/...' 别名解析到 frontend/src（vite 在浏览器侧做同样的事）
 *  2. 给无扩展名的 TS 风格相对/绝对导入补 .ts
 * 浏览器侧由 vite.config.ts 的 alias 处理，Node 测试侧用这个钩子保持同源码。
 * 用法：node --import ./tests/alias-register.mjs ./tests/migration.test.mjs
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '..', 'src')

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const srcRoot = ${JSON.stringify(srcRoot)}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return nextResolve('file://' + srcRoot + '/' + specifier.slice(2) + '.ts', context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = new URL(specifier, context.parentURL)
    if (!existsSync(fileURLToPath(base))) {
      const withTs = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(withTs))) {
        return nextResolve(withTs.href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
`

const dataUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64')
register(dataUrl, pathToFileURL(here))
void existsSync
