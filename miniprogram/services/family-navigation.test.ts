import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("wx", { switchTab: vi.fn(), showToast: vi.fn() });
});

it("加入后的目标只传递一次，tab URL 不附加参数", async () => {
  const navigation = await import("./family-navigation");
  navigation.openFamilyTab("joined-family");
  expect(wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/families/index" }));
  expect(navigation.consumeFamilyDestination()).toBe("joined-family");
  expect(navigation.consumeFamilyDestination()).toBeNull();
  navigation.openFamilyTab();
  expect(navigation.consumeFamilyDestination()).toBe("");
});

it("导航失败清除目标并提示重试", async () => {
  const navigation = await import("./family-navigation");
  vi.mocked(wx.switchTab).mockImplementation(options => {
    options.fail?.({ errMsg: "switchTab:fail" });
    return Promise.resolve({ errMsg: "switchTab:fail" });
  });
  navigation.openFamilyTab("joined-family");
  expect(navigation.consumeFamilyDestination()).toBeNull();
  expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ icon: "none" }));
});
