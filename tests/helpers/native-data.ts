/** Emulate WeChat setData paths rather than assigning literal dotted keys. */
export function applyNativeData(data: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current: Record<string, unknown> = data;
    for (const key of keys.slice(0, -1)) {
      const child = current[key];
      if (!child || typeof child !== "object") throw new Error(`Missing setData parent: ${path}`);
      current = child as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (last !== undefined) current[last] = structuredClone(value);
  }
}
