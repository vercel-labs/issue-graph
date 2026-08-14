# Contributing

Issues and focused pull requests are welcome.

## Setup

```bash
gh repo clone vercel-labs/xref
cd xref
bun install --frozen-lockfile
```

## Verify changes

```bash
bun run check
```

Add or update tests for behavior changes. Keep the graph core runtime-agnostic,
and keep filesystem or subprocess dependencies out of the main package entry
point.

For transport changes, also compare both implementations against a live public
repository:

```bash
bun run scripts/verify-transports.ts <number> <owner/repo> <depth>
```
