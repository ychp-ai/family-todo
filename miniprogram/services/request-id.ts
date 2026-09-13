export class RequestIdUnavailableError extends Error {
  public constructor() {
    super("无法生成安全请求标识，请更新微信后重试。");
    this.name = "RequestIdUnavailableError";
  }
}

/** UUID v4；不以时间或 Math.random 回退替代平台密码学随机数。 */
export function createRequestId(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof wx === "undefined" || typeof wx.getRandomValues !== "function") {
      reject(new RequestIdUnavailableError());
      return;
    }
    try {
      wx.getRandomValues({
        length: 16,
        success(result) {
          // 平台桥接的 ArrayBuffer 来自另一 JS realm，不能用 instanceof 判定。
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(ArrayBuffer.prototype.slice.call(result.randomValues, 0));
          } catch {
            reject(new RequestIdUnavailableError());
            return;
          }
          if (bytes.byteLength !== 16) {
            reject(new RequestIdUnavailableError());
            return;
          }
          const hex = Array.from(bytes, (byte, index) => {
            const value = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
            return value.toString(16).padStart(2, "0");
          }).join("");
          resolve(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
        },
        fail() { reject(new RequestIdUnavailableError()); },
      });
    } catch {
      reject(new RequestIdUnavailableError());
    }
  });
}
