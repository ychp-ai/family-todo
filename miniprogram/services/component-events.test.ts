import { expect, it, vi } from "vitest";
import { componentActions, componentMethods } from "./component-events";

it("forwards control value and the inner control dataset to the page", () => {
  const triggerEvent = vi.fn();
  const methods = componentMethods(["change"]);
  const change = methods.change;
  if (!change) throw new Error("missing change");
  change.call({ triggerEvent }, { type: "change", timeStamp: 0, target: {id:"",tagName:"picker",offsetTop:0,offsetLeft:0,dataset:{}}, detail: { value: ["member"] }, currentTarget: { id:"",tagName:"picker",offsetTop:0,offsetLeft:0, dataset: { id: "task", kind: "viewer" } } } as WechatMiniprogram.CustomEvent<Record<string, unknown>>);
  const action = triggerEvent.mock.calls[0]?.[1];
  const handler = vi.fn(); const page = { change: handler };
  componentActions(["change"]).call(page, { detail: action, currentTarget: { dataset: {} } } as Parameters<ReturnType<typeof componentActions>>[0]);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ detail: { value: ["member"] }, currentTarget: expect.objectContaining({ dataset: { id: "task", kind: "viewer" } }) }));
  expect(handler.mock.contexts[0]).toBe(page);
});

it("ignores actions outside the page's explicit allowlist", () => {
  const remove = vi.fn();
  componentActions(["change"]).call({ remove }, { detail: { handler: "remove", detail: {}, dataset: {} } } as Parameters<ReturnType<typeof componentActions>>[0]);
  expect(remove).not.toHaveBeenCalled();
});
