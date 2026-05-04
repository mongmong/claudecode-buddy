#!/usr/bin/env node
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { listModels } from "./lib/list-models.mjs";

function runSetup() {
  const cli = detectOpencode({ env: process.env });
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const cfg = detectConfig({ configPath });

  const lines = [];
  if (cli.installed) {
    lines.push(`✓ opencode is installed (${cli.binary}, ${cli.version})`);
  } else {
    lines.push(`✗ opencode is not installed`);
    lines.push("");
    lines.push(cli.guidance);
  }

  lines.push("");

  if (cfg.ok) {
    lines.push(`✓ default model configured: ${cfg.model} (from ${cfg.configPath})`);
  } else {
    lines.push(`✗ ${cfg.error}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

function runModels() {
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const result = listModels({ configPath });
  if (!result.ok) {
    process.stdout.write(`${result.error}\n`);
    process.exit(0);
  }
  for (const m of result.value) {
    process.stdout.write(`${m}\n`);
  }
  process.exit(0);
}

const subcommand = process.argv[2];

switch (subcommand) {
  case "setup":
    runSetup();
    break;
  case "models":
    runModels();
    break;
  default:
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: opencode-companion <setup|models|review|prompt> [args...]\n`,
    );
    process.exit(2);
}
