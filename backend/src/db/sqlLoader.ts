import { readFile } from 'node:fs/promises';

const sqlCache = new Map<string, Promise<string>>();
const servicesSqlRoot = new URL('../services/', import.meta.url);

// 运行时查询 SQL 统一从 backend/src/services/ 读取。
// build 后复制到 dist/services/，因此这里基于当前模块相对路径解析即可。
export function loadServiceSql(relativePath: string): Promise<string> {
  const sqlUrl = new URL(relativePath, servicesSqlRoot);
  const cacheKey = sqlUrl.href;

  const cached = sqlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = readFile(sqlUrl, 'utf8');
  sqlCache.set(cacheKey, pending);
  return pending;
}
