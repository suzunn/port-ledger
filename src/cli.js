#!/usr/bin/env node

import {
  assertPort,
  listLeases,
  parseDuration,
  pruneLeases,
  releaseLease,
  reserveLease,
} from "./ledger.js";

const HELP = `port-ledger

I keep local development port assignments predictable across projects.

Usage:
  port-ledger reserve <project> [--port <number>] [--from <number>] [--to <number>] [--ttl <duration>]
  port-ledger list
  port-ledger release <project>
  port-ledger prune

Options:
  --registry <path>  Use a custom JSON registry path.
  --json             Print machine-readable JSON.
  --help             Show this help text.

Durations use m, h, or d suffixes, for example 30m, 8h, or 2d.
`;

function parseArguments(argv) {
  const positional = [];
  const options = {};
  const valueFlags = new Set(["--port", "--from", "--to", "--ttl", "--registry"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json" || argument === "--help") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positional.push(argument);
  }

  return { positional, options };
}

function registryOptions(options) {
  return options.registry ? { registryPath: options.registry } : {};
}

function printLeases(leases) {
  if (leases.length === 0) {
    console.log("No active port leases.");
    return;
  }

  console.log("PROJECT\tPORT\tEXPIRES");
  for (const lease of leases) {
    console.log(`${lease.project}\t${lease.port}\t${lease.expiresAt}`);
  }
}

async function main(argv) {
  const { positional, options } = parseArguments(argv);
  const [command, project, ...extra] = positional;

  if (options.help || !command) {
    console.log(HELP);
    return;
  }
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}`);
  }

  if (command === "reserve") {
    if (!project) {
      throw new Error("reserve requires a project name.");
    }

    const result = await reserveLease(project, {
      ...registryOptions(options),
      port: options.port === undefined ? undefined : assertPort(options.port),
      from: options.from === undefined ? undefined : assertPort(options.from, "from"),
      to: options.to === undefined ? undefined : assertPort(options.to, "to"),
      ttlMs: options.ttl === undefined ? undefined : parseDuration(options.ttl),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const prefix = result.reused ? "Reusing" : "Reserved";
    console.log(`${prefix} ${result.lease.project} on port ${result.lease.port} until ${result.lease.expiresAt}.`);
    return;
  }

  if (command === "list") {
    if (project) {
      throw new Error("list does not accept a project name.");
    }
    const leases = await listLeases(registryOptions(options));
    options.json ? console.log(JSON.stringify(leases, null, 2)) : printLeases(leases);
    return;
  }

  if (command === "release") {
    if (!project) {
      throw new Error("release requires a project name.");
    }
    const result = await releaseLease(project, registryOptions(options));
    options.json
      ? console.log(JSON.stringify(result, null, 2))
      : console.log(result.removed ? `Released ${project}.` : `${project} had no active lease.`);
    return;
  }

  if (command === "prune") {
    if (project) {
      throw new Error("prune does not accept a project name.");
    }
    const result = await pruneLeases(registryOptions(options));
    options.json
      ? console.log(JSON.stringify(result, null, 2))
      : console.log(`Removed ${result.removed} expired lease(s).`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`port-ledger: ${error.message}`);
  process.exitCode = 1;
});
