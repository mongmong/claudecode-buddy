# claudecode-buddy

Claude Code plugins that wrap third-party coding/review CLIs so you can drive them from inside Claude Code.

Currently ships:

- **[opencode](plugins/opencode/README.md)** — wraps the [opencode](https://opencode.ai) CLI. `/opencode:review` (with optional `--style adversarial`), write-capable `/opencode:run` (foreground or `--background`), session continuity per `(plan-or-branch, role, model)`, opt-in Stop-hook review gate.
- **[codex](plugins/codex/README.md)** — wraps the [codex](https://github.com/openai/codex) CLI with full v0.5.1 parity to the opencode plugin. `/codex:review`, `/codex:run` (default sandbox `read-only`; `--yolo` → `workspace-write`), `/codex:rescue`, `/codex:status`/`result`/`cancel`, `/codex:gate`, session continuity via codex's UUID thread-ids. Replaces the third-party openai-codex plugin's `/codex:*` namespace.

## Install

The repo is a [Claude Code plugin marketplace](https://docs.anthropic.com/claude-code/plugins) — register it once and install whichever plugins you want. Two install paths, both first-class:

### From GitHub (regular users)

In Claude Code, run:

```
/plugin marketplace add mongmong/claudecode-buddy
/plugin install opencode@claudecode-buddy
/plugin install codex@claudecode-buddy   # optional; replaces openai-codex if installed
```

Restart Claude Code.

### Migrating from openai-codex (third-party) to claudecode-buddy/codex

If you previously installed [openai-codex](https://github.com/openai/codex-plugin-cc)'s `/codex:*` commands and want to switch to the claudecode-buddy variant (which adds session continuity, fd-bound TOCTOU defenses, fail-open hooks, Stop-hook gate, `--variant` reasoning effort, `--style adversarial`, and the full opencode-plugin feature surface):

1. **REQUIRED — uninstall openai-codex first** to avoid namespace collision:
   ```
   /plugin uninstall codex@openai-codex
   ```
2. **(Optional cleanup)** Remove the marketplace registration:
   ```
   /plugin marketplace remove openai-codex
   ```
3. **(Optional)** Recover any background-job output from openai-codex BEFORE uninstalling — `/codex:result <id>` against the OLD plugin. **openai-codex's persisted job and session state does NOT migrate** to claudecode-buddy/codex; the new plugin starts with fresh state under `<project>/.claudecode-buddy/codex/`.
4. Install ours:
   ```
   /plugin install codex@claudecode-buddy
   ```
5. Restart Claude Code (or `/plugin marketplace update claudecode-buddy && /reload-plugins`).

Same `/codex:review`, `/codex:run`, `/codex:rescue`, `codex:codex-rescue` (aliased to `codex-review`) commands work post-migration. New features become available — see `plugins/codex/CHANGELOG.md` for the v0.5.1 release notes.

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
