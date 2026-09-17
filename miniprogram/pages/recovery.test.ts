import { applyNativeData } from "../../tests/helpers/native-data";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AppOptions } from "../types/app";

vi.mock("../config/index", () => ({
  appConfig: { cloudbaseEnvId: "recovery-test-env", apiFunctionName: "api" },
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("home exposes recovered pending immediately after the first verified session, without sending it", async () => {
  vi.resetModules();
  const user = {id: randomUUID(), displayName: "我", version: 1};
  const requestId = randomUUID();
  const pending = {version: 1, state: "pending", action: "task.delete", requestId: randomUUID(), payload: {id: randomUUID(), expectedVersion: 1}};
  const readStorage = vi.fn(() => pending);
  vi.stubGlobal("wx", {getStorageSync: readStorage});
  let app: AppOptions | undefined;
  vi.stubGlobal("App", (definition: AppOptions) => {app = definition;});
  vi.stubGlobal("getApp", () => app);
  const identity = await import("../services/identity-api");
  vi.spyOn(identity, "ensureIdentity").mockResolvedValue({ok: true, requestId, data: {user}});
  vi.spyOn(await import("../services/request-id"), "createRequestId").mockResolvedValue(requestId);
  await import("../app");
  expect(readStorage).not.toHaveBeenCalled();
  const {personalApi} = await import("../services/personal-api");
  const write = vi.spyOn(personalApi, "write");
  vi.spyOn(personalApi, "read").mockRejectedValue(new Error("offline lists"));
  type PageHarness = {data: Record<string, unknown>; visible: boolean; setData(patch: Record<string, unknown>): void; refresh(): Promise<void>};
  let page: PageHarness | undefined;
  vi.stubGlobal("Page", (definition: PageHarness) => { page = definition; definition.setData = patch => applyNativeData(definition.data, patch); });
  await import("./home/index");
  if (!page) throw new Error("page not registered");
  expect(page.data.pendingCount).toBe(0);
  page.visible = true;
  // Keep the simulated page from scheduling foreground refresh timers.
  Object.assign(page, {schedule: vi.fn()});
  await page.refresh();
  expect(identity.ensureIdentity).toHaveBeenCalledTimes(1);
  expect(readStorage).toHaveBeenCalledWith(expect.stringContaining(user.id));
  expect(page.data.pendingCount).toBe(1);
  expect(write).not.toHaveBeenCalled();
});
