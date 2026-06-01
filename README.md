# port-ledger

I built `port-ledger` to keep local development port assignments predictable
when several projects run at the same time. It stores expiring reservations in
a small JSON registry, checks whether a candidate port is actually available,
and uses a lock file plus atomic writes so concurrent terminal sessions do not
overwrite each other.

## Why I Use It

Development servers often default to the same ports. I wanted a dependency-free
CLI that could reserve a port before a service starts and release it when the
service stops. Expiring leases keep abandoned assignments from accumulating.

## Requirements

- Node.js 20 or newer

## Install

```bash
npm install --global port-ledger
```

## Usage

Reserve the first available port in the default `3000-3999` range:

```bash
port-ledger reserve web
```

Choose a range and lease duration:

```bash
port-ledger reserve api --from 4100 --to 4199 --ttl 12h
```

Reserve an exact port:

```bash
port-ledger reserve docs --port 4400
```

Inspect or remove leases:

```bash
port-ledger list
port-ledger release docs
port-ledger prune
```

Add `--json` to any command when another tool needs structured output. Add
`--registry <path>` to isolate a workspace or test environment.

## Behavior

- I keep active leases in `~/.port-ledger/leases.json` by default.
- I discard expired leases before reading or writing the registry.
- I return the existing lease when the same project reserves a port twice.
- I reject a requested port when another lease or local process already uses it.
- I hold a short-lived lock and rename a temporary file into place for each
  registry update.

## Development

```bash
npm install
npm run ci
```

The CI workflow runs syntax checks and the Node.js test suite on Node.js 20 and
22.

## License

MIT
