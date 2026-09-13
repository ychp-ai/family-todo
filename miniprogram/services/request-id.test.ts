import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { isUuid } from "@family-todo/contracts";
import { createRequestId, RequestIdUnavailableError } from "./request-id";

describe("小程序请求 UUID", () => {
  it("使用平台的 16 字节随机数，保留随机位并设置 v4 与 variant", async () => {
    const getRandomValues = vi.fn((options: WechatMiniprogram.GetRandomValuesOption) => {
      options.success?.({ randomValues: new Uint8Array(Array.from({ length: 16 }, (_, index) => index)).buffer, errMsg: "ok" });
    });
    vi.stubGlobal("wx", { getRandomValues });
    const id = await createRequestId();
    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(isUuid(id)).toBe(true);
    expect(getRandomValues).toHaveBeenCalledWith(expect.objectContaining({ length: 16 }));
  });

  it("接受开发者工具桥接返回的跨 realm ArrayBuffer", async () => {
    const buffer: ArrayBuffer = runInNewContext("new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]).buffer");
    expect(buffer instanceof ArrayBuffer).toBe(false);
    vi.stubGlobal("wx", { getRandomValues: (options: WechatMiniprogram.GetRandomValuesOption) => {
      options.success?.({ randomValues: buffer, errMsg: "ok" });
    } });
    await expect(createRequestId()).resolves.toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it.each([undefined, {}])("缺少平台能力时拒绝且不降级随机来源", async (wx) => {
    vi.stubGlobal("wx", wx);
    await expect(createRequestId()).rejects.toBeInstanceOf(RequestIdUnavailableError);
  });

  it.each([0, 15, 17])("拒绝长度为 %i 的平台响应", async (length) => {
    vi.stubGlobal("wx", { getRandomValues: (options: WechatMiniprogram.GetRandomValuesOption) => {
      options.success?.({ randomValues: new ArrayBuffer(length), errMsg: "ok" });
    } });
    await expect(createRequestId()).rejects.toBeInstanceOf(RequestIdUnavailableError);
  });

  it("屏蔽平台同步异常与异步失败的内部内容", async () => {
    vi.stubGlobal("wx", { getRandomValues: () => { throw new Error("SECRET"); } });
    await expect(createRequestId()).rejects.toThrow("无法生成安全请求标识");
    vi.stubGlobal("wx", { getRandomValues: (options: WechatMiniprogram.GetRandomValuesOption) => {
      options.fail?.({ errMsg: "SECRET" });
    } });
    await expect(createRequestId()).rejects.toThrow("无法生成安全请求标识");
  });
});
