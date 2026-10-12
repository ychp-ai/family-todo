import { productInfo } from "../../config/product-info";

Page({
  data: { productInfo, version: `本地版本 ${productInfo.version}` },
  onLoad() {
    try {
      const { envVersion, version } = wx.getAccountInfoSync().miniProgram;
      const label = { develop: "开发版", trial: "体验版", release: "正式版" }[envVersion];
      this.setData({ version: version ? `版本 ${version} · ${label}` : `本地版本 ${productInfo.version} · ${label}` });
    } catch {
      // 部分预览环境没有账号信息，保留本地客户端版本。
    }
  },
});
