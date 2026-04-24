
/**
* 把 tag 值标准化为“去首尾空格后的非空字符串”。
*
* @param value 原始 tag 值
* @returns 去空后的值；若为空则返回 null
*/
export function trimTagValue(value: string | undefined): string | null {
 if (!value) {
   return null;
 }

 const trimmed = value.trim();
 return trimmed.length > 0 ? trimmed : null;
}

/**
 * 以支持权重和反对权重加权随机得到结果
 * @param supportingWeight
 * @param nonSupportingWeight 为负数
 * @returns true 代表支持，false 代表反对
 */
export function weightedBoolean(supportingWeight: number, nonSupportingWeight: number): boolean {
  const totalWeight = supportingWeight + nonSupportingWeight;
  return Math.random() * totalWeight < supportingWeight;
}

/**
 * 从给定列表中均匀随机取一个值。
 *
 * @param values 候选值列表
 * @returns 被选中的值
 */
export function pickRandom<T>(values: T[]): T {
  const index = Math.min(values.length - 1, Math.floor(Math.random() * values.length));
  return values[index];
}