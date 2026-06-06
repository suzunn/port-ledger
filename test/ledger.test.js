import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listLeases,
  parseDuration,
  pruneLeases,
  readLedger,
  releaseLease,
  reserveLease,
  withRegistryLock,
} from "../src/ledger.js";

function temporaryRegistry() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "port-ledger-"));
  return path.join(directory, "leases.json");
}

const now = new Date("2026-06-01T07:00:00.000Z");

test("parseDuration accepts supported units and rejects invalid input", () => {
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("8h"), 28_800_000);
  assert.equal(parseDuration("2d"), 172_800_000);
  assert.throws(() => parseDuration("15"), /duration/);
});

test("reserveLease chooses the first available unreserved port", async () => {
  const registryPath = temporaryRegistry();
  const occupied = new Set([4100]);
  const probe = async (port) => !occupied.has(port);

  const first = await reserveLease("api", {
    registryPath,
    from: 4100,
    to: 4102,
    now,
    probe,
  });
  const second = await reserveLease("web", {
    registryPath,
    from: 4100,
    to: 4102,
    now,
    probe,
  });

  assert.equal(first.lease.port, 4101);
  assert.equal(second.lease.port, 4102);
  assert.deepEqual(
    readLedger(registryPath).leases.map((lease) => lease.project),
    ["api", "web"],
  );
});

test("reserveLease reuses an active project lease", async () => {
  const registryPath = temporaryRegistry();
  const probe = async () => true;

  const first = await reserveLease("api", { registryPath, port: 4200, now, probe });
  const second = await reserveLease("api", { registryPath, now, probe });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.lease.port, 4200);
  assert.equal(readLedger(registryPath).leases.length, 1);
});

test("reserveLease rejects changing an active project lease port", async () => {
  const registryPath = temporaryRegistry();
  const probe = async () => true;

  await reserveLease("api", { registryPath, port: 4200, now, probe });

  await assert.rejects(
    reserveLease("api", { registryPath, port: 4201, now, probe }),
    /api already reserves port 4200/,
  );
  assert.equal(readLedger(registryPath).leases[0].port, 4200);
});

test("reserveLease reports when no candidate ports are available", async () => {
  const registryPath = temporaryRegistry();
  const probe = async () => false;

  await assert.rejects(
    reserveLease("api", { registryPath, from: 4210, to: 4211, now, probe }),
    /No available port found between 4210 and 4211/,
  );
  assert.deepEqual(readLedger(registryPath).leases, []);
});

test("listLeases and pruneLeases remove expired leases", async () => {
  const registryPath = temporaryRegistry();
  const probe = async () => true;

  await reserveLease("expired", {
    registryPath,
    port: 4300,
    ttlMs: 60_000,
    now,
    probe,
  });

  assert.deepEqual(
    await listLeases({ registryPath, now: new Date(now.getTime() + 120_000) }),
    [],
  );
  assert.equal((await pruneLeases({ registryPath, now })).removed, 0);
});

test("releaseLease removes matching projects without affecting other leases", async () => {
  const registryPath = temporaryRegistry();
  const probe = async () => true;

  await reserveLease("api", { registryPath, port: 4400, now, probe });
  await reserveLease("web", { registryPath, port: 4401, now, probe });

  assert.deepEqual(await releaseLease("api", { registryPath, now }), { removed: true });
  assert.deepEqual(
    (await listLeases({ registryPath, now })).map((lease) => lease.project),
    ["web"],
  );
});

test("readLedger rejects registries with an unsupported schema", () => {
  const registryPath = temporaryRegistry();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ version: 2, leases: [] }), "utf8");

  assert.throws(() => readLedger(registryPath), /Registry must contain version 1 leases/);
});

test("withRegistryLock reports live lock contention", async () => {
  const registryPath = temporaryRegistry();
  fs.writeFileSync(`${registryPath}.lock`, "other-process\n");

  await assert.rejects(
    withRegistryLock(registryPath, async () => undefined, {
      timeoutMs: 10,
      retryMs: 1,
    }),
    /Registry is busy/,
  );
});
