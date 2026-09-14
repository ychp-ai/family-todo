import { describe, expect, it, vi } from "vitest";
import { dataPatch, patchData } from "./patch-data";
import { applyNativeData } from "../../tests/helpers/native-data";

describe("native component data patches", () => {
  it("does not send structurally unchanged API responses", () => {
    const data = { rows: [{ id: "a", title: "相同", access: { view: true } }], status: "ready" };
    const setData = vi.fn();
    patchData({ data, setData }, structuredClone(data));
    expect(setData).not.toHaveBeenCalled();
  });
  it("updates only the changed field of one keyed card", () => {
    const data = { rows: [{ id: "a", done: false }, { id: "b", done: false }], title: "家庭" };
    const patch = dataPatch(data, { rows: [{ id: "a", done: true }, { id: "b", done: false }] });
    expect(patch).toEqual({ "rows[0].done": true });
    applyNativeData(data, patch);
    expect(data.rows).toEqual([{ id: "a", done: true }, { id: "b", done: false }]);
  });
  it("replaces resized lists and objects with removed fields", () => {
    expect(dataPatch({ rows: [1, 2], value: { a: 1, b: 2 } }, { rows: [2], value: { a: 1 } }))
      .toEqual({ rows: [2], value: { a: 1 } });
  });
});
