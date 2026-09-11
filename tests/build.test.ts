import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";

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
  const app = vi.fn((options: { onLaunch(): void }) => options.onLaunch());
  const page = vi.fn();
  const component = vi.fn();
  for (const file of result.outputFiles) {
    runInNewContext(file.text, { App: app, Page: page, Component: component });
  }
  expect(app).toHaveBeenCalledOnce();
  expect(page).toHaveBeenCalledOnce();
  expect(component).toHaveBeenCalledOnce();
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
