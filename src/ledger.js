import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPortAvailable } from "./ports.js";

const DEFAULT_FROM = 3000;
const DEFAULT_TO = 3999;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * Return the default JSON registry location for the current user.
 *
 * @returns {string} Absolute path to the lease registry file.
 */
export function defaultRegistryPath() {
  return path.join(os.homedir(), ".port-ledger", "leases.json");
}

/**
 * Parse a compact lease duration such as `30m`, `8h`, or `2d`.
 *
 * @param {string} value - Duration string with a minute, hour, or day suffix.
 * @returns {number} Duration in milliseconds.
 */
export function parseDuration(value) {
  if (typeof value !== "string") {
    throw new Error("TTL must use a duration such as 30m, 8h, or 2d.");
  }

  const match = /^([1-9]\d*)(m|h|d)$/.exec(value);
  if (!match) {
    throw new Error("TTL must use a duration such as 30m, 8h, or 2d.");
  }

  const units = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Number(match[1]) * units[match[2]];
}

/**
 * Validate and normalize a TCP port value.
 *
 * @param {unknown} value - Value to parse as a port number.
 * @param {string} [label="port"] - Label used in validation errors.
 * @returns {number} Integer TCP port between 1 and 65535.
 */
export function assertPort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

/**
 * Read the lease registry, returning an empty ledger when it does not exist.
 *
 * @param {string} [registryPath=defaultRegistryPath()] - Registry file to read.
 * @returns {{version: number, leases: Array<object>}} Parsed ledger data.
 */
export function readLedger(registryPath = defaultRegistryPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (parsed.version !== 1 || !Array.isArray(parsed.leases)) {
      throw new Error("Registry must contain version 1 leases.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, leases: [] };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Registry is not valid JSON: ${registryPath}`);
    }
    throw error;
  }
}

/**
 * Persist a lease registry with an atomic temporary-file rename.
 *
 * @param {string} registryPath - Registry file to write.
 * @param {{version: number, leases: Array<object>}} ledger - Ledger payload.
 * @returns {void}
 */
export function writeLedger(registryPath, ledger) {
  const directory = path.dirname(registryPath);
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, registryPath);
}

/**
 * Remove expired leases from an in-memory ledger snapshot.
 *
 * @param {{version: number, leases: Array<object>}} ledger - Ledger to prune.
 * @param {Date} [now=new Date()] - Clock value used for expiration checks.
 * @returns {{ledger: {version: number, leases: Array<object>}, removed: number}} Pruned ledger and removal count.
 */
export function pruneExpired(ledger, now = new Date()) {
  const nowMs = now.getTime();
  const leases = ledger.leases.filter(
    (lease) => new Date(lease.expiresAt).getTime() > nowMs,
  );

  return {
    ledger: { ...ledger, leases },
    removed: ledger.leases.length - leases.length,
  };
}

/**
 * Run a task while holding the registry lock file.
 *
 * @template T
 * @param {string} registryPath - Registry path whose lock should be held.
 * @param {() => Promise<T> | T} task - Work to perform while locked.
 * @param {{timeoutMs?: number, staleLockMs?: number, retryMs?: number}} [options] - Lock timing options.
 * @returns {Promise<T>} The task result.
 */
export async function withRegistryLock(registryPath, task, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const retryMs = options.retryMs ?? 25;
  const lockPath = `${registryPath}.lock`;
  const startedAt = Date.now();
  let handle;

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  while (!handle) {
    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(handle, `${process.pid}\n`, "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs > staleLockMs) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Registry is busy: ${registryPath}`);
      }

      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await task();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Reserve a port lease for a project, reusing an existing active lease when present.
 *
 * @param {string} project - Project name that owns the lease.
 * @param {object} [options] - Reservation options.
 * @param {string} [options.registryPath] - Custom registry file path.
 * @param {Date} [options.now] - Clock value used for timestamps and pruning.
 * @param {number} [options.ttlMs] - Lease duration in milliseconds.
 * @param {number} [options.from] - First port in the search range.
 * @param {number} [options.to] - Last port in the search range.
 * @param {number} [options.port] - Exact port to reserve.
 * @param {(port: number) => Promise<boolean>} [options.probe] - Availability probe.
 * @returns {Promise<{lease: object, reused: boolean}>} Reserved lease and reuse flag.
 */
export async function reserveLease(project, options = {}) {
  if (!project || typeof project !== "string") {
    throw new Error("Project name is required.");
  }

  const registryPath = options.registryPath ?? defaultRegistryPath();
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const from = assertPort(options.from ?? DEFAULT_FROM, "from");
  const to = assertPort(options.to ?? DEFAULT_TO, "to");
  const requestedPort =
    options.port === undefined ? undefined : assertPort(options.port);
  const probe = options.probe ?? isPortAvailable;

  if (from > to) {
    throw new Error("from must not be greater than to.");
  }

  return withRegistryLock(registryPath, async () => {
    const { ledger } = pruneExpired(readLedger(registryPath), now);
    const existing = ledger.leases.find((lease) => lease.project === project);

    if (existing) {
      if (requestedPort !== undefined && requestedPort !== existing.port) {
        throw new Error(
          `${project} already reserves port ${existing.port}; release it before changing ports.`,
        );
      }
      writeLedger(registryPath, ledger);
      return { lease: existing, reused: true };
    }

    const usedPorts = new Set(ledger.leases.map((lease) => lease.port));
    const candidates =
      requestedPort === undefined
        ? Array.from({ length: to - from + 1 }, (_, index) => from + index)
        : [requestedPort];

    for (const port of candidates) {
      if (usedPorts.has(port) || !(await probe(port))) {
        continue;
      }

      const lease = {
        project,
        port,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      ledger.leases.push(lease);
      ledger.leases.sort((left, right) => left.port - right.port);
      writeLedger(registryPath, ledger);
      return { lease, reused: false };
    }

    if (requestedPort !== undefined) {
      throw new Error(`Port ${requestedPort} is already reserved or in use.`);
    }
    throw new Error(`No available port found between ${from} and ${to}.`);
  });
}

/**
 * Release the active lease for a project.
 *
 * @param {string} project - Project name whose lease should be removed.
 * @param {object} [options] - Release options.
 * @param {string} [options.registryPath] - Custom registry file path.
 * @param {Date} [options.now] - Clock value used for pruning.
 * @returns {Promise<{removed: boolean}>} Whether a lease was removed.
 */
export async function releaseLease(project, options = {}) {
  if (!project || typeof project !== "string") {
    throw new Error("Project name is required.");
  }

  const registryPath = options.registryPath ?? defaultRegistryPath();
  const now = options.now ?? new Date();

  return withRegistryLock(registryPath, async () => {
    const { ledger } = pruneExpired(readLedger(registryPath), now);
    const leases = ledger.leases.filter((lease) => lease.project !== project);
    const removed = leases.length !== ledger.leases.length;
    writeLedger(registryPath, { ...ledger, leases });
    return { removed };
  });
}

/**
 * List active leases after pruning expired entries.
 *
 * @param {object} [options] - Listing options.
 * @param {string} [options.registryPath] - Custom registry file path.
 * @param {Date} [options.now] - Clock value used for pruning.
 * @returns {Promise<Array<object>>} Active leases sorted by registry order.
 */
export async function listLeases(options = {}) {
  const registryPath = options.registryPath ?? defaultRegistryPath();
  const now = options.now ?? new Date();

  return withRegistryLock(registryPath, async () => {
    const { ledger, removed } = pruneExpired(readLedger(registryPath), now);
    if (removed > 0) {
      writeLedger(registryPath, ledger);
    }
    return ledger.leases;
  });
}

/**
 * Remove expired leases from the registry.
 *
 * @param {object} [options] - Prune options.
 * @param {string} [options.registryPath] - Custom registry file path.
 * @param {Date} [options.now] - Clock value used for expiration checks.
 * @returns {Promise<{removed: number}>} Number of expired leases removed.
 */
export async function pruneLeases(options = {}) {
  const registryPath = options.registryPath ?? defaultRegistryPath();
  const now = options.now ?? new Date();

  return withRegistryLock(registryPath, async () => {
    const { ledger, removed } = pruneExpired(readLedger(registryPath), now);
    writeLedger(registryPath, ledger);
    return { removed };
  });
}
