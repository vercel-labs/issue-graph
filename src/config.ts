import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dashboardQuery } from "./dashboard-query.js";
import type { Model } from "./html.js";
import { hasCode, publishLocal, readLocal, stateHome } from "./local-store.js";
import { scoring, type Weights } from "./scoring.js";

interface Defaults {
  weights?: Partial<Weights>;
}

export interface Config {
  schemaVersion: 1;
  defaults?: Defaults;
  providers?: Record<
    string,
    {
      defaults?: Defaults;
      scopes?: Record<string, Defaults>;
    }
  >;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
}

function identifier(value: string, label: string) {
  if (
    !value.trim() ||
    value.length > 512 ||
    ["__proto__", "prototype", "constructor"].includes(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error(`invalid ${label}`);
}

export function validateConfig(value: unknown): Config {
  const config = object(value, "config");
  fields(config, ["schemaVersion", "defaults", "providers"], "config");
  if (config.schemaVersion !== 1) throw new Error("unsupported config schemaVersion");
  const defaults = (value: unknown) => {
    const data = object(value, "defaults");
    fields(data, ["weights"], "defaults");
    if (data.weights !== undefined) scoring.validate(data.weights);
  };
  if (config.defaults !== undefined) defaults(config.defaults);
  if (config.providers !== undefined)
    for (const [id, raw] of Object.entries(object(config.providers, "providers"))) {
      identifier(id, "provider");
      const provider = object(raw, "provider");
      fields(provider, ["defaults", "scopes"], "provider");
      if (provider.defaults !== undefined) defaults(provider.defaults);
      if (provider.scopes !== undefined)
        for (const [scope, data] of Object.entries(object(provider.scopes, "scopes"))) {
          identifier(scope, "scope");
          defaults(data);
        }
    }
  return config as unknown as Config;
}

export const configPath = () => join(stateHome(), "config.json");
export function readConfig(): Config {
  try {
    return validateConfig(JSON.parse(readLocal(configPath())));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { schemaVersion: 1 };
    throw new Error(
      `Cannot read config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveWeights(
  config: Config,
  provider?: string,
  scope?: string,
  overrides: Partial<Weights> = {},
): Weights {
  const p =
    provider && Object.hasOwn(config.providers ?? {}, provider)
      ? config.providers?.[provider]
      : undefined;
  const s = scope && Object.hasOwn(p?.scopes ?? {}, scope) ? p?.scopes?.[scope] : undefined;
  return {
    ...scoring.defaults,
    ...config.defaults?.weights,
    ...p?.defaults?.weights,
    ...s?.weights,
    ...scoring.validate(overrides),
  };
}

export function modelDefaults(models: Model[], config = readConfig()): Record<string, Weights> {
  return Object.fromEntries(
    models.map((m) => [
      dashboardQuery.identity(m),
      resolveWeights(config, m.provider.id, dashboardQuery.scope(m)),
    ]),
  );
}

export function setWeights(weights: Partial<Weights>, provider?: string, scope?: string): Config {
  scoring.validate(weights);
  if (!Object.keys(weights).length) throw new Error("provide at least one weight");
  if (provider !== undefined) identifier(provider, "provider");
  if (scope !== undefined) {
    identifier(scope, "scope");
    if (!provider) throw new Error("--scope requires --provider");
  }
  mkdirSync(stateHome(), { recursive: true, mode: 0o700 });
  const lock = `${configPath()}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST"))
      throw new Error(
        `Config is locked. Retry after the other writer finishes. If it crashed, remove ${lock}.`,
      );
    throw error;
  }
  try {
    const config = readConfig();
    let target: Defaults;
    if (!provider) target = config.defaults ??= {};
    else {
      config.providers ??= {};
      config.providers[provider] ??= {};
      const p = config.providers[provider];
      if (!scope) target = p.defaults ??= {};
      else {
        p.scopes ??= {};
        target = p.scopes[scope] ??= {};
      }
    }
    target.weights = { ...target.weights, ...weights };
    publishLocal(configPath(), `${JSON.stringify(validateConfig(config), null, 2)}\n`, true);
    return config;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
