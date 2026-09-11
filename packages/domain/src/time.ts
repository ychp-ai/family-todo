export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

/** 统一序列化瞬时时间；业务日期规则在对应领域落地后再添加。 */
export function formatUtcInstant(value: Date): string {
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 0 || value.getUTCFullYear() > 9999) {
    throw new Error("Instant must be a valid four-digit-year date.");
  }
  return value.toISOString();
}
