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
          if (!(result.randomValues instanceof ArrayBuffer) || result.randomValues.byteLength !== 16) {
            reject(new RequestIdUnavailableError());
            return;
          }
          const bytes = new Uint8Array(result.randomValues);
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
