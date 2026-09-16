import { afterEach, expect, it, vi } from "vitest";

type Control = { data: Record<string, unknown>; methods: Record<string, (event?: unknown) => void> };
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("重复分段控件传递所选项，锁定状态不会改变日程", async () => {
  let control: Control | undefined;
  vi.stubGlobal("Component", (definition: Control) => { control = definition; });
  await import("./editor-schedule/index");
  if (!control) throw new Error("missing component");
  const select = control.methods.selectRepeat;
  if (!select) throw new Error("missing selectRepeat");
  const triggerEvent = vi.fn();
  const instance = { data: { scheduleLocked: false, shareOnly: false, saving: false, uncertain: false }, triggerEvent };
  const event = { currentTarget: { dataset: { index: 2 } } };
  select.call(instance, event);
  expect(triggerEvent).toHaveBeenCalledWith("action", { handler: "repeatChange", detail: { value: 2 }, dataset: {} });
  for (const key of ["scheduleLocked", "shareOnly", "saving", "uncertain"] as const) {
    triggerEvent.mockClear(); instance.data[key] = true;
    select.call(instance, event);
    expect(triggerEvent).not.toHaveBeenCalled(); instance.data[key] = false;
  }
});
