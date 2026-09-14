interface DataTarget {
  data: object;
  setData(patch: Record<string, unknown>): void;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Send leaf changes only. Replacing a collection is necessary when its shape changes. */
export function dataPatch(previous: object, next: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  function diff(before: unknown, after: unknown, path: string): void {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      after.forEach((value: unknown, index: number) => diff(before[index], value, `${path}[${index}]`));
      return;
    }
    if (object(before) && object(after)) {
      const keys = Object.keys(after);
      if (keys.length === Object.keys(before).length && keys.every(key => Object.prototype.hasOwnProperty.call(before, key))) {
        keys.forEach(key => diff(before[key], after[key], `${path}.${key}`));
        return;
      }
    }
    patch[path] = after;
  }
  const current = previous as Record<string, unknown>;
  Object.entries(next).forEach(([key, value]) => diff(current[key], value, key));
  return patch;
}
export function patchData(target: DataTarget, next: Record<string, unknown>): void {
  const patch = dataPatch(target.data, next);
  if (Object.keys(patch).length) target.setData(patch);
}
