
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
