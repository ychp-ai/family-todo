import { beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalProfile, saveLocalProfile } from "./local-profile";

const storage = new Map<string, unknown>();
const files = { accessSync: vi.fn(), copyFileSync: vi.fn(), unlinkSync: vi.fn() };
beforeEach(() => {
  storage.clear(); vi.clearAllMocks();
  files.accessSync.mockImplementation(() => undefined);
  vi.stubGlobal("wx", {
    env: { USER_DATA_PATH: "wxfile://usr" }, getFileSystemManager: () => files,
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: vi.fn((key: string, value: unknown) => storage.set(key, value)),
  });
});
describe("本机头像昵称", () => {
  it("持久化临时头像并隔离账号；更换头像清理旧文件", () => {
    const first = saveLocalProfile("one", " 小明 ", "wxfile://temp/one");
    expect(first.displayName).toBe("小明");
    expect(files.copyFileSync).toHaveBeenCalledWith("wxfile://temp/one", first.avatarPath);
    expect(readLocalProfile("one")).toEqual(first);
    expect(readLocalProfile("two")).toBeNull();
    const second = saveLocalProfile("one", "明明", "wxfile://temp/two");
    expect(second.avatarPath).not.toBe(first.avatarPath);
    expect(files.unlinkSync).toHaveBeenCalledWith(first.avatarPath);
  });
  it("存储失败保留原资料和临时头像，清理新副本后允许重试", () => {
    const original = saveLocalProfile("one", "小明", "wxfile://temp/one");
    vi.mocked(wx.setStorageSync).mockImplementationOnce(() => { throw new Error("full"); });
    expect(() => saveLocalProfile("one", "小红", "wxfile://temp/two")).toThrow("资料保存失败");
    expect(readLocalProfile("one")).toEqual(original);
    expect(files.unlinkSync).not.toHaveBeenCalledWith(original.avatarPath);
    expect(files.unlinkSync).not.toHaveBeenCalledWith("wxfile://temp/two");
    expect(saveLocalProfile("one", "小红", "wxfile://temp/two").displayName).toBe("小红");
  });
  it("丢失的头像回退为空，昵称仍然可用", () => {
    saveLocalProfile("one", "小明", "wxfile://temp/one");
    files.accessSync.mockImplementation(() => { throw new Error("missing"); });
    expect(readLocalProfile("one")).toEqual({ displayName: "小明", avatarPath: "" });
  });
  it("只改昵称不会重复复制头像，拒绝空昵称", () => {
    const original = saveLocalProfile("one", "小明", "wxfile://temp/one");
    saveLocalProfile("one", "新昵称", original.avatarPath);
    expect(files.copyFileSync).toHaveBeenCalledTimes(1);
    expect(() => saveLocalProfile("one", "  ", "")).toThrow("请填写");
  });
});
