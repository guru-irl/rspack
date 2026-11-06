import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const corePath = createRequire(import.meta.url).resolve("@rspack/core");
const childScript = `
const { rspack } = require(process.env.TEST_CORE_PATH);
const fs = require("node:fs");
const config = {
  context: process.env.TEST_CONTEXT,
  entry: "./c",
  mode: "development",
  name: process.env.TEST_COMPILER_NAME,
  output: { path: process.env.TEST_OUTPUT },
};
const compiler = rspack(config);
function finish() {
  compiler.close(() => {
    if (!process.env.TEST_SECOND_COMPILER) return;
    const second = rspack({
      ...config,
      name: "ssr",
      output: { path: process.env.TEST_OUTPUT, filename: "second.js" },
    });
    second.run((error, stats) => {
      if (error || stats.hasErrors()) {
        console.error(error || stats.toString("errors-only"));
        process.exitCode = 1;
      }
      second.close(() => {});
    });
  });
}
let count = 0;
const watching = compiler.watch({}, (error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString("errors-only"));
    process.exitCode = 1;
    return watching.close(() => compiler.close(() => {}));
  }
  if (++count === 1) {
    if (process.env.TEST_REPAIR_DIAG) fs.rmdirSync(process.env.RSPACK_MEM_DIAG);
    return watching.invalidate();
  }
  watching.close(finish);
});
`;

function runChild(context, dir, diag, repair = false, second = false) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TEST_CORE_PATH: corePath,
      TEST_CONTEXT: context,
      TEST_OUTPUT: join(dir, "dist"),
      TEST_COMPILER_NAME: 'client "main"',
    };
    if (diag === undefined) delete env.RSPACK_MEM_DIAG;
    else env.RSPACK_MEM_DIAG = diag;
    if (repair) env.TEST_REPAIR_DIAG = "1";
    else delete env.TEST_REPAIR_DIAG;
    if (second) env.TEST_SECOND_COMPILER = "1";
    else delete env.TEST_SECOND_COMPILER;
    const child = spawn(process.execPath, ["-e", childScript], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  description: "writes allocator diagnostics for builds and rebuilds without failing on write errors",
  options() {
    return { entry: "./c" };
  },
  async build(context) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rspack-mem-diag-")));
    try {
      const log = join(dir, "diagnostic.jsonl");
      const result = await runChild(context.getSource(), dir, log, false, true);
      expect(result).toEqual({ code: 0, output: "" });
      const lines = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(lines).toHaveLength(3);
      expect(new Set(lines.map(line => line.pid)).size).toBe(1);
      expect(lines.map(line => line.seq)).toEqual([1, 2, 3]);
      expect(lines.map(line => line.kind)).toEqual(["build", "rebuild", "build"]);
      expect(lines.map(line => line.compiler)).toEqual([
        'client "main"', 'client "main"', "ssr",
      ]);
      expect(lines.map(line => line.compiler_path)).toEqual([
        'client "main"', 'client "main"', "ssr",
      ]);
      expect(lines[0].compiler_id).toBe(lines[1].compiler_id);
      expect(lines[0].compiler_id).not.toBe(lines[2].compiler_id);
      for (const line of lines) {
        expect(line.event).toBe("native_build_complete");
        expect(line).not.toHaveProperty("child");
        expect(Number.isInteger(line.ts_ms)).toBe(true);
        expect(line.ts_ms).toBeGreaterThan(0);
        expect(Math.abs(Date.now() - line.ts_ms)).toBeLessThan(120000);
        for (const field of ["current_rss", "peak_rss", "current_commit", "peak_commit", "page_faults"]) {
          expect(typeof line[field]).toBe("number");
          expect(line[field]).toBeGreaterThanOrEqual(0);
        }
        if (process.platform === "linux") {
          expect(typeof line.os_rss).toBe("number");
          expect(line.os_rss).toBeGreaterThan(0);
        }
        const graph = line.module_graph;
        expect(graph).toBeTruthy();
        const checkMap = map => {
          expect(Number.isInteger(map.len)).toBe(true);
          expect(Number.isInteger(map.some)).toBe(true);
          expect(Number.isInteger(map.capacity)).toBe(true);
          expect(map.some).toBeGreaterThanOrEqual(0);
          expect(map.some).toBeLessThanOrEqual(map.len);
          expect(map.len).toBeLessThanOrEqual(map.capacity);
        };
        checkMap(graph.dep_meta_map);
        checkMap(graph.connection_to_condition);
        expect(graph.connections.base.some + graph.connections.overlay_values).toBeGreaterThan(0);
        for (const name of ["connections", "dependency_id_to_connection_id"]) {
          const map = graph[name];
          checkMap(map.base);
          checkMap(map.overlay);
          expect(map.overlay_values).toBeLessThanOrEqual(map.overlay.some);
          expect(map.both_values).toBeLessThanOrEqual(map.overlay_values);
          expect(map.both_values).toBeLessThanOrEqual(map.base.some);
          expect(map.same_values).toBeLessThanOrEqual(map.both_values);
        }
      }
      const invalid = join(dir, "invalid-diagnostic");
      mkdirSync(invalid);
      const failedOpen = await runChild(context.getSource(), dir, invalid, true);
      expect(failedOpen.code).toBe(0);
      expect(failedOpen.output.match(/rspack memory diagnostic disabled:/g)).toHaveLength(1);
      expect(existsSync(invalid)).toBe(false);
      if (process.platform === "linux" && existsSync("/dev/full")) {
        const failedWrite = await runChild(context.getSource(), dir, "/dev/full");
        expect(failedWrite.code).toBe(0);
        expect(failedWrite.output.match(/rspack memory diagnostic disabled:/g)).toHaveLength(1);
      }
      const disabled = await runChild(context.getSource(), dir, undefined);
      expect(disabled).toEqual({ code: 0, output: "" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
