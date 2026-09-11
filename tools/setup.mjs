import { copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

const configDirectory = new URL("../miniprogram/config/", import.meta.url);
await mkdir(configDirectory, { recursive: true });
try {
  await copyFile(
    new URL("local.example.ts", configDirectory),
    new URL("local.ts", configDirectory),
    constants.COPYFILE_EXCL,
  );
  console.log("已创建小程序本地配置，云环境默认禁用。");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
