import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./probe.mjs", import.meta.url));

function runArm(sizeOnly) {
  const env = { ...process.env };
  if (sizeOnly) {
    env.RSPACK_EMITTED_SOURCES = "size-only";
  } else {
    delete env.RSPACK_EMITTED_SOURCES;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`probe ${sizeOnly ? "on" : "off"} exited ${code ?? signal}\n${stdout}\n${stderr}`));
        return;
      }
      const marker = stdout.split("\n").find((line) => line.startsWith("FILES="));
      if (!marker) {
        reject(new Error(`probe returned no output manifest\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(marker.slice("FILES=".length)));
    });
  });
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  name: "size-only-emitted-sources",
  description: "releases emitted asset content while retaining sizes and emitted-hook content",
  async run() {
    const off = await runArm(false);
    const on = await runArm(true);
    assert.deepEqual(on, off, "the switch must not change emitted files");
  },
};
