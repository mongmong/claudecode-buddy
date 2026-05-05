# claudecode-buddy

Claude Code plugins that wrap third-party coding/review CLIs so you can drive them from inside Claude Code.

Currently ships:

- **[opencode](plugins/opencode/README.md)** — wraps the [opencode](https://opencode.ai) CLI. `/opencode:review` (with optional `--style adversarial`), write-capable `/opencode:run` (foreground or `--background`), session continuity per `(plan-or-branch, role, model)`, opt-in Stop-hook review gate.

## Install

The repo is a [Claude Code plugin marketplace](https://docs.anthropic.com/claude-code/plugins) — register it once and install whichever plugins you want. Two install paths, both first-class:

### From GitHub (regular users)

In Claude Code, run:

```
/plugin marketplace add mongmong/claudecode-buddy
/plugin install opencode@claudecode-buddy
```

Restart Claude Code.

Equivalent if you prefer to hand-edit `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claudecode-buddy": {
      "source": {
        "source": "github",
        "repo": "mongmong/claudecode-buddy"
      }
    }
  },
  "enabledPlugins": {
    "opencode@claudecode-buddy": true
  }
}
```

GitHub-source installs track `main` HEAD; tagged releases are queued for a future plan.

### From a local checkout (developers / dogfooders)

Same `extraKnownMarketplaces` mechanism, just with a filesystem source pointing at your clone:

```json
{
  "extraKnownMarketplaces": {
    "claudecode-buddy": {
      "source": {
        "source": "filesystem",
        "path": "/path/to/your/checkout/of/claudecode-buddy"
      }
    }
  },
  "enabledPlugins": {
    "opencode@claudecode-buddy": true
  }
}
```

Restart Claude Code. The plugin reloads from your checkout on every Claude Code restart, so `git pull` + restart is enough to pick up changes. **No special install script** — dogfooding goes through the exact same Claude Code marketplace mechanism a regular user uses, by design (a custom symlink workaround can mask environment issues that real users hit).

### Migrating from a previous local install

Earlier versions of this repo (before plan 004) shipped a `scripts/install-local.sh` that symlinked the plugin into a synthetic `~/.claude/plugins/marketplaces/claudecode-buddy-local/` directory and auto-generated a marketplace manifest there. That approach has been retired (see `docs/architecture/decisions.md` → D-012).

If you previously ran `bash scripts/install-local.sh`:

1. **Remove the stale marketplace directory:**

   ```bash
   rm -rf ~/.claude/plugins/marketplaces/claudecode-buddy-local
   ```

2. **If you also manually edited `~/.claude/settings.json` to enable the old `claudecode-buddy-local` marketplace, remove those entries:**

   ```jsonc
   // Remove these from settings.json if present:
   "extraKnownMarketplaces": {
     "claudecode-buddy-local": { ... }   // ← delete this entry
   },
   "enabledPlugins": {
     "opencode@claudecode-buddy-local": true   // ← delete this entry
   }
   ```

3. **Register the new `claudecode-buddy` marketplace** following the install instructions above.

4. **Restart Claude Code** to pick up the new registration.

## Project layout

- `plugins/<name>/` — each plugin lives here, mirroring the [openai-codex plugin](https://github.com/openai/codex-plugin-cc) layout.
- `.claude-plugin/marketplace.json` — top-level marketplace manifest (lists every plugin under `plugins/`).
- `docs/plans/` — sequentially-numbered plans (`000-...`, `001-...`, `002-...`).
- `docs/architecture/decisions.md` — cross-cutting architecture decisions.
- `tests/` — workspace-level tests (`node:test`).

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the development workflow (every change goes through plan-write → dual-review → implement → 3-reviewer code-review → ship).
