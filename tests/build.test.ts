import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";

import type { AppOptions } from "../miniprogram/types/app";

it("清理函数 bundle 脱离工作区可加载且不会执行维护 CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-todo-cleanup-"));
  try {
    copyFileSync("cloudfunctions/cleanup-query-sessions/index.js", join(directory, "index.cjs"));
    const output = execFileSync(process.execPath, ["-e", `
      const { main } = require('./index.cjs');
      main({}).then(result => process.stdout.write(JSON.stringify(result)));
    `], { cwd: directory, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ ok: false, code: "INVALID_CLEANUP_EVENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("云函数 bundle 脱离工作区和 node_modules 后可独立调用", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-todo-function-"));
  try {
    copyFileSync("cloudfunctions/api/index.js", join(directory, "index.cjs"));
    const output = execFileSync(process.execPath, ["-e", `
      const { main } = require('./index.cjs');
      main({ apiVersion: 1, action: 'system.health', requestId: 'ac9b6a08-4357-4a19-98bb-f1bffef9c4d0', payload: {} })
        .then(result => process.stdout.write(JSON.stringify(result)));
    `], { cwd: directory, encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { status: "ok", service: "api" } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("身份 SDK bundle 可脱离根 node_modules 加载，未配置云环境时明确失败", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-todo-identity-sdk-"));
  try {
    await build({
      entryPoints: ["packages/infra-cloudbase/src/identity-sdk.ts"], bundle: true,
      platform: "node", format: "cjs", target: "node20", outfile: join(directory, "identity.cjs"),
    });
    const output = execFileSync(process.execPath, ["-e", `
      delete process.env.SCF_NAMESPACE;
      const { createCloudBaseIdentityStore } = require('./identity.cjs');
      try { createCloudBaseIdentityStore({provider:'wechat',appId:'wx0123456789abcdef',subject:'local-test'}); }
      catch (error) { process.stdout.write(error.message); }
    `], { cwd: directory, encoding: "utf8" });
    expect(output).toBe("Cloud function environment is unavailable.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("默认配置的 App 和首页在无云 SDK 时完成注册和启动", async () => {
  const result = await build({
    entryPoints: ["miniprogram/app.ts", "miniprogram/pages/home/index.ts", "miniprogram/components/page-state/index.ts"],
    bundle: true, platform: "neutral", format: "cjs", target: "es2018", outdir: "dist/smoke", write: false,
    plugins: [{
      name: "use-example-config",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/local$/ }, () => ({ path: resolve("miniprogram/config/local.example.ts") }));
      },
    }],
  });
  const app = vi.fn((options: AppOptions & { onLaunch(): void }) => options.onLaunch());
  const page = vi.fn();
  const component = vi.fn();
  for (const file of result.outputFiles) {
    runInNewContext(file.text, { App: app, Page: page, Component: component });
  }
  expect(app).toHaveBeenCalledOnce();
  expect(app.mock.calls[0]?.[0].globalData).toMatchObject({ cloudStatus: "unconfigured" });
  expect(app.mock.calls[0]?.[0].globalData.session.state).toEqual({ status: "idle" });
  expect(page).toHaveBeenCalledOnce();
  expect(component).toHaveBeenCalledOnce();
});

it("客户端独立 bundle 可从 App 会话调用身份服务，并拒绝泄露字段的响应", async () => {
  const result = await build({
    entryPoints: ["miniprogram/app.ts"], bundle: true, platform: "neutral", format: "cjs",
    target: "es2018", write: false,
    plugins: [{
      name: "use-test-config",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/local$/ }, () => ({ path: "local", namespace: "test-config" }));
        builder.onLoad({ filter: /.*/, namespace: "test-config" }, () => ({ contents: 'export const localConfig = { cloudbaseEnvId: "test-env", apiFunctionName: "api" };' }));
      },
    }],
  });
  const user = { id: "95855838-6cb6-48b1-94b4-60e41d96cc44", displayName: "我", version: 1 };
  const init = vi.fn();
  const callFunction = vi.fn(async ({ data }: { data: { requestId: string } }) => ({
    result: { ok: true, requestId: data.requestId, data: { user } },
  }));
  const random = vi.fn((options: WechatMiniprogram.GetRandomValuesOption) => {
    options.success?.({ randomValues: new Uint8Array(16).buffer, errMsg: "ok" });
  });
  const app = vi.fn((options: AppOptions & { onLaunch(): void }) => options.onLaunch());
  for (const file of result.outputFiles) {
    runInNewContext(file.text, {
      App: app, getApp: () => app.mock.calls[0]?.[0],
      wx: { cloud: { init, callFunction }, getRandomValues: random },
      ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
    });
  }
  const options = app.mock.calls[0]?.[0];
  if (!options) throw new Error("App did not register");
  expect(init).toHaveBeenCalledWith({ env: "test-env", traceUser: false });
  expect(callFunction).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
  const session = options.globalData.session;
  expect(await session.ensure()).toEqual(user);
  expect(callFunction).toHaveBeenCalledWith({ name: "api", data: {
    apiVersion: 1, action: "identity.ensure", requestId: "00000000-0000-4000-8000-000000000000", payload: {},
  } });
  session.invalidate();
  callFunction.mockImplementationOnce(async ({ data }) => ({ result: {
    ok: true, requestId: data.requestId, data: { user: { ...user, openId: "private" } },
  } }));
  await expect(session.ensure()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  expect(session.state).not.toHaveProperty("user");
});

it("setup 首次生成配置，再次执行保留用户配置", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-todo-setup-"));
  try {
    mkdirSync(join(directory, "tools"));
    mkdirSync(join(directory, "miniprogram/config"), { recursive: true });
    copyFileSync("tools/setup.mjs", join(directory, "tools/setup.mjs"));
    copyFileSync("miniprogram/config/local.example.ts", join(directory, "miniprogram/config/local.example.ts"));
    const script = join(directory, "tools/setup.mjs");
    execFileSync(process.execPath, [script]);
    const configPath = join(directory, "miniprogram/config/local.ts");
    expect(readFileSync(configPath, "utf8")).toContain('cloudbaseEnvId: ""');
    writeFileSync(configPath, "// user configuration\n");
    execFileSync(process.execPath, [script]);
    expect(readFileSync(configPath, "utf8")).toBe("// user configuration\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
