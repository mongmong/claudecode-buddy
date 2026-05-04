# Tests

Workspace-level test harness using Node's built-in `node:test` runner. No external dependencies.

## Layout

- `tests/<plugin>/*.test.mjs` — tests for each plugin under `plugins/<plugin>/`.
- `tests/<plugin>/helpers.mjs` — shared utilities for that plugin's tests.

## Running

```
npm test
```

## Tiers

1. **Unit** — pure functions; no subprocess. Always run.
2. **Integration with mocked opencode** — companion script invoked as a subprocess with `OPENCODE_BIN` overridden to a fixture script. Always run.
3. **End-to-end with real opencode** — companion script invoked against a real `opencode run` call. Gated behind `OPENCODE_E2E=1` env var. Run locally before each PR.
