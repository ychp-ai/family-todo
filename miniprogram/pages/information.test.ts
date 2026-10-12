import { afterEach, beforeEach, expect, it, vi } from "vitest";

type InformationPage = {
  data: { version?: string; document?: { title: string } | null };
  setData: (patch: Record<string, unknown>) => void;
  onLoad: (query: Record<string, string | undefined>) => void;
};
let captured: InformationPage | undefined;

beforeEach(() => {
  vi.resetModules();
  captured = undefined;
  vi.stubGlobal("Page", (page: InformationPage) => {
    captured = page;
    page.setData = patch => Object.assign(page.data, patch);
  });
  vi.stubGlobal("wx", { getAccountInfoSync: vi.fn(), setNavigationBarTitle: vi.fn() });
  // 阅读说明不能依赖身份初始化或云端业务服务。
  vi.stubGlobal("getApp", () => { throw new Error("Information pages must not require a session"); });
});
afterEach(() => vi.unstubAllGlobals());

function page(): InformationPage {
  if (!captured) throw new Error("Page was not registered");
  return captured;
}

it.each([
  ["develop", "", "本地版本 1.0.5 · 开发版"],
  ["trial", "", "本地版本 1.0.5 · 体验版"],
  ["trial", "1.2.0", "版本 1.2.0 · 体验版"],
  ["release", "1.2.3", "版本 1.2.3 · 正式版"],
] as const)("关于页优先显示微信版本，%s 无版本号时显示本地版本", async (envVersion, version, expected) => {
  vi.mocked(wx.getAccountInfoSync).mockReturnValue({
    miniProgram: { appId: "test", envVersion, version },
    plugin: { appId: "", version: "" },
  });
  await import("./about/index");
  page().onLoad({});
  expect(page().data.version).toBe(expected);
});

it("无法读取账号版本时仍可打开关于页面", async () => {
  vi.mocked(wx.getAccountInfoSync).mockImplementation(() => { throw new Error("unavailable"); });
  await import("./about/index");
  expect(() => page().onLoad({})).not.toThrow();
  expect(page().data.version).toBe("本地版本 1.0.5");
});

it.each([["agreement", "用户协议"], ["privacy", "隐私说明"]])("无需登录即可读取 %s", async (type, title) => {
  await import("./legal/index");
  page().onLoad({ type });
  expect(page().data.document?.title).toBe(title);
  expect(wx.setNavigationBarTitle).toHaveBeenCalledWith({ title });
});

it.each([undefined, "other", "__proto__"])("非法说明类型 %s 显示未找到，不误展示协议", async type => {
  await import("./legal/index");
  page().onLoad({ type });
  expect(page().data.document).toBeNull();
  expect(wx.setNavigationBarTitle).not.toHaveBeenCalled();
});
