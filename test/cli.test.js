import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(...arguments_) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
  });
}

test("CLI reserves, lists, and releases a requested port", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "port-ledger-cli-"));
  const registry = path.join(directory, "leases.json");
  const port = "45991";

  const reserve = runCli("reserve", "docs", "--port", port, "--registry", registry, "--json");
  assert.equal(reserve.status, 0, reserve.stderr);
  assert.equal(JSON.parse(reserve.stdout).lease.port, Number(port));

  const list = runCli("list", "--registry", registry, "--json");
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].project, "docs");

  const release = runCli("release", "docs", "--registry", registry, "--json");
  assert.equal(release.status, 0, release.stderr);
  assert.deepEqual(JSON.parse(release.stdout), { removed: true });
});

test("CLI reports unknown options without a stack trace", () => {
  const result = runCli("list", "--wat");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --wat/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
