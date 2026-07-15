/**
 * Uniform config precedence resolution (issue #99).
 *
 * Takes three plain-object layers — default YAML, overlay YAML, and a
 * materialized env layer — and produces one merged config tree where every
 * leaf carries its provenance (which layer supplied it). This is a pure
 * function: it reads no environment and performs no parsing. `loadConfig`
 * is responsible for building the `env` layer (the one place that knows how
 * env vars like LASTLIGHT_MODELS map onto config paths) and feeding it in.
 *
 * Precedence per leaf path: env > overlay > default. Nested mappings are
 * merged key-by-key so each leaf resolves (and is attributed) independently;
 * arrays and scalars are replaced wholesale by the highest layer that
 * supplies them.
 */

export type ConfigSource = "default" | "overlay" | "env";

export interface ConfigLayers {
  default: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  env: Record<string, unknown>;
}

export interface ResolvedConfig {
  /** Merged plain config tree (env > overlay > default). */
  value: Record<string, unknown>;
  /** Mirror of `value`; object nodes stay nested, leaves are a ConfigSource. */
  sources: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveConfigLayers(layers: ConfigLayers): ResolvedConfig {
  const ordered: Array<[ConfigSource, Record<string, unknown>]> = [
    ["default", layers.default],
    ["overlay", layers.overlay ?? {}],
    ["env", layers.env],
  ];
  const value: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [source, layer] of ordered) {
    mergeLayer(value, sources, layer, source);
  }
  return { value, sources };
}

function mergeLayer(
  value: Record<string, unknown>,
  sources: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: ConfigSource,
): void {
  for (const [key, incoming] of Object.entries(layer)) {
    if (isPlainObject(incoming)) {
      const childValue = isPlainObject(value[key]) ? (value[key] as Record<string, unknown>) : {};
      const childSources = isPlainObject(sources[key]) ? (sources[key] as Record<string, unknown>) : {};
      mergeLayer(childValue, childSources, incoming, source);
      value[key] = childValue;
      sources[key] = childSources;
    } else {
      value[key] = incoming;
      sources[key] = source;
    }
  }
}
