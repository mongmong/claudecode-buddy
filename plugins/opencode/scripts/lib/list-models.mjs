import { readFileSync, existsSync } from "node:fs";

export function listModels({ configPath }) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `failed to parse ${configPath}: ${err.message}` };
  }

  const found = new Set();

  if (typeof parsed.model === "string" && parsed.model.length > 0) {
    found.add(parsed.model);
  }

  if (parsed.provider && typeof parsed.provider === "object") {
    for (const [providerName, providerCfg] of Object.entries(parsed.provider)) {
      if (!providerCfg || typeof providerCfg !== "object") continue;
      const models = providerCfg.models;
      if (!models || typeof models !== "object") continue;
      for (const modelId of Object.keys(models)) {
        found.add(`${providerName}/${modelId}`);
      }
    }
  }

  if (found.size === 0) {
    return {
      ok: false,
      error:
        `no models found in ${configPath}. ` +
        `Set a default \`model\` field or add provider.<name>.models.<id> entries.`,
    };
  }

  const all = [...found];
  const def = typeof parsed.model === "string" ? parsed.model : null;
  const rest = all.filter((m) => m !== def).sort();
  return { ok: true, value: def ? [def, ...rest] : rest };
}
