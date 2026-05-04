#!/usr/bin/env bash
# Install workspace plugins into Claude Code's local marketplace via symlinks.
# Idempotent — re-running upgrades any existing symlinks. Refuses to clobber
# non-symlink files/directories at link targets to avoid eating user data.
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE_ROOT="${HOME}/.claude/plugins/marketplaces/claudecode-buddy-local"
MARKETPLACE_PLUGINS="${MARKETPLACE_ROOT}/plugins"

mkdir -p "${MARKETPLACE_PLUGINS}"

MARKETPLACE_JSON="${MARKETPLACE_ROOT}/.claude-plugin/marketplace.json"
mkdir -p "${MARKETPLACE_ROOT}/.claude-plugin"

# Use Node (already required by package.json engines) for safe JSON construction.
# The script is delivered via a QUOTED heredoc (<<'NODE') so bash leaves the
# JS source untouched — no expansion of JS template literals like ${name}.
node --input-type=module - "${WORKSPACE_DIR}" "${MARKETPLACE_JSON}" <<'NODE'
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const workspaceDir = process.argv[2];
const out = process.argv[3];
const pluginsRoot = join(workspaceDir, 'plugins');
const plugins = [];

for (const name of readdirSync(pluginsRoot)) {
  const dir = join(pluginsRoot, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`WARNING: ${name} has no readable .claude-plugin/plugin.json (${err.message}) — skipping`);
    continue;
  }
  plugins.push({
    name,
    description: manifest.description ?? '(no description)',
    version: manifest.version ?? '0.0.0',
    author: { name: 'claudecode-buddy' },
    source: `./plugins/${name}`,
  });
}

const marketplace = {
  name: 'claudecode-buddy-local',
  owner: { name: 'claudecode-buddy' },
  metadata: {
    description: 'Local-only marketplace for claudecode-buddy plugins under development.',
    version: '0.1.0',
  },
  plugins,
};

writeFileSync(out, JSON.stringify(marketplace, null, 2) + '\n');
NODE

echo "Wrote ${MARKETPLACE_JSON}"

# Symlink each plugin under plugins/. SAFETY: refuse to clobber non-symlinks.
for plugin_dir in "${WORKSPACE_DIR}/plugins"/*/; do
  plugin_name="$(basename "${plugin_dir%/}")"
  link_target="${MARKETPLACE_PLUGINS}/${plugin_name}"
  if [ -e "${link_target}" ] || [ -L "${link_target}" ]; then
    if [ -L "${link_target}" ]; then
      rm "${link_target}"
    else
      echo "ERROR: ${link_target} exists and is not a symlink." >&2
      echo "       Refusing to clobber. Remove it manually if you're sure: rm -rf ${link_target}" >&2
      exit 1
    fi
  fi
  ln -s "${plugin_dir%/}" "${link_target}"
  echo "Linked ${plugin_name}: ${link_target} -> ${plugin_dir%/}"
done

echo ""
echo "Done. Restart Claude Code to load the plugins."
echo "  Slash commands:    /opencode:setup, /opencode:review, /opencode:run, /opencode:status, /opencode:result, /opencode:cancel"
echo "  Subagents:         opencode:opencode-review, opencode:opencode-run"
echo ""
echo "To uninstall: scripts/uninstall-local.sh"
