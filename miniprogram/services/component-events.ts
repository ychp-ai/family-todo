/** Components emit only UI intent; pages retain API, permissions and request recovery. */
interface ComponentEvent {
  handler: string;
  detail: unknown;
  dataset: Record<string, unknown>;
}
interface EventSource {
  triggerEvent(name: string, detail: ComponentEvent): void;
}
export function componentMethods(names: readonly string[]) {
  return Object.fromEntries(names.map(handler => [handler, function (this: EventSource, event: WechatMiniprogram.CustomEvent<Record<string, unknown>>) {
    this.triggerEvent("action", { handler, detail: event.detail, dataset: event.currentTarget.dataset });
  }]));
}
export function componentActions(names: readonly string[]) {
  const allowed = new Set(names);
  return function (this: Record<string, unknown>, event: WechatMiniprogram.CustomEvent<ComponentEvent>) {
    const action = event.detail;
    if (!action || !allowed.has(action.handler)) return;
    const handler = this[action.handler];
    if (typeof handler !== "function") return;
    return handler.call(this, { ...event, detail: action.detail, currentTarget: { ...event.currentTarget, dataset: action.dataset } });
  };
}
