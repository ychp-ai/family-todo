import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sourceFiles(directory: string): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(path) ? [path] : [];
  });
}

function imports(path: string) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const typeOnly = clause?.isTypeOnly === true || (
        !clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
      );
      return [{ name: statement.moduleSpecifier.text, typeOnly: Boolean(typeOnly) }];
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      return [{ name: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly }];
    }
    return [];
  });
}

it("核心包依赖方向保持单向，且不引入平台 SDK", () => {
  const allowed: Record<string, Array<string>> = {
    contracts: [], domain: [], ports: ["domain"],
    application: ["contracts", "domain", "ports"],
  };
  for (const [name, dependencies] of Object.entries(allowed)) {
    const directory = resolve("packages", name);
    for (const file of sourceFiles(directory)) {
      for (const dependency of imports(file)) {
        if (dependency.name.startsWith(".")) {
          expect(relative(directory, resolve(dirname(file), dependency.name)), file).not.toMatch(/^\.\./);
        } else {
          expect(dependencies.map((item) => `@family-todo/${item}`), `${file}: ${dependency.name}`).toContain(dependency.name);
        }
      }
    }
  }
});

it("小程序仅引用目录内运行时代码，页面不直连云 SDK", () => {
  const directory = resolve("miniprogram");
  for (const file of sourceFiles(directory)) {
    for (const dependency of imports(file)) {
      if (dependency.typeOnly) continue;
      expect(dependency.name, file).toMatch(/^\./);
      expect(relative(directory, resolve(dirname(file), dependency.name)), file).not.toMatch(/^\.\./);
    }
    if (file.includes(`${join("miniprogram", "pages")}/`) || file.includes(`${join("miniprogram", "components")}/`)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\bwx\s*\.\s*cloud\b/);
    }
  }
});

it("已注册页面与组件具备完整的小程序资源，并排除测试上传", () => {
  const app = JSON.parse(readFileSync("miniprogram/app.json", "utf8")) as { pages: Array<string>; useExtendedLib?: { weui?: boolean } };
  for (const page of app.pages) {
    for (const extension of ["ts", "json", "wxml", "wxss"]) {
      expect(existsSync(`miniprogram/${page}.${extension}`), `${page}.${extension}`).toBe(true);
    }
  }
  const visited = new Set<string>();
  const extendedComponents = new Set([
    "weui-miniprogram/cells/cells",
    "weui-miniprogram/cell/cell",
    "weui-miniprogram/half-screen-dialog/half-screen-dialog"
  ]);
  function checkComponents(configPath: string): void {
    if (visited.has(configPath)) return;
    visited.add(configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { usingComponents?: Record<string, string> };
    for (const path of Object.values(config.usingComponents ?? {})) {
      if (extendedComponents.has(path)) {
        expect(app.useExtendedLib?.weui).toBe(true);
        continue;
      }
      expect(path).toMatch(/^\//);
      for (const extension of ["ts", "json", "wxml", "wxss"]) {
        expect(existsSync(`miniprogram${path}.${extension}`), `${path}.${extension}`).toBe(true);
      }
      checkComponents(`miniprogram${path}.json`);
    }
  }
  for (const page of app.pages) checkComponents(`miniprogram/${page}.json`);
  const project = JSON.parse(readFileSync("project.config.json", "utf8")) as {
    packOptions: { ignore: Array<{ type: string; value: string }> };
  };
  const patterns = project.packOptions.ignore.filter((entry) => entry.type === "regexp").map((entry) => new RegExp(entry.value));
  expect(patterns.some((pattern) => pattern.test("services/app-api-client.test.ts"))).toBe(true);
  expect(patterns.some((pattern) => pattern.test("shared/contracts.js"))).toBe(false);
});
