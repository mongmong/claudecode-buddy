#!/usr/bin/env bash
# Remove the symlinks created by install-local.sh.
# Leaves the local marketplace and other plugins under it intact.
# SAFETY: only removes paths that are actually symlinks pointing into THIS workspace.
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE_PLUGINS="${HOME}/.claude/plugins/marketplaces/claudecode-buddy-local/plugins"

if [ ! -d "${MARKETPLACE_PLUGINS}" ]; then
  echo "No local marketplace at ${MARKETPLACE_PLUGINS}; nothing to do."
  exit 0
fi

for plugin_dir in "${WORKSPACE_DIR}/plugins"/*/; do
  plugin_name="$(basename "${plugin_dir%/}")"
  link_target="${MARKETPLACE_PLUGINS}/${plugin_name}"
  if [ -L "${link_target}" ]; then
    target_resolved="$(readlink "${link_target}")"
    if [ "${target_resolved}" = "${plugin_dir%/}" ]; then
      rm "${link_target}"
      echo "Unlinked ${plugin_name}"
    else
      echo "SKIP: ${link_target} is a symlink to ${target_resolved}, not this workspace's plugin." >&2
    fi
  elif [ -e "${link_target}" ]; then
    echo "SKIP: ${link_target} exists but is not a symlink; refusing to remove." >&2
  fi
done

echo "Done. Restart Claude Code to drop the plugins from the local marketplace."
