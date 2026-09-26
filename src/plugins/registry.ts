import Ajv from "ajv";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { runCommand, type CommandOptions } from "../core/process";
import { resolveWithinWorkspace } from "../core/security.ts";

export interface PluginContext {
  cwd: string;
  signal: AbortSignal;
  exec(script: string, options?: Partial<Omit<CommandOptions, "script" | "signal">>): ReturnType<typeof runCommand>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  artifact(data: unknown): Promise<string>;
  log(message: string): void;
}
export interface Extractor {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  configSchema?: Record<string, any>;
  outputSchema: Record<string, any>;
  examples?: unknown[];
  run(input: any, config: any, ctx: PluginContext): unknown | Promise<unknown>;
}
export interface LoadedExtractor { definition: Extractor; version: string; source: string }
const ajv = new Ajv({ allErrors: true, strict: false });
const anySchema = {};
const builtins: Extractor[] = [
  { name: "json", description: "Parse a JSON string into structured data.", inputSchema: { type: "string" }, outputSchema: anySchema, run: input => JSON.parse(input) },
  { name: "lines", description: "Turn nonempty lines into choice options, records, and items. Includes a none option.", inputSchema: { type: "string" }, outputSchema: { type: "object" }, run: input => candidates(input.split(/\r?\n/).filter((s: string) => s.trim()).map((text: string) => ({ text }))) },
  { name: "rg-matches", description: "Parse rg --json matches into choice options, records, and items containing path, line, and excerpt. Includes a none option.", inputSchema: { type: "string" }, outputSchema: { type: "object" }, run: input => {
    const matches = input.split(/\r?\n/).filter(Boolean).map((s: string) => JSON.parse(s)).filter((entry: any) => entry.type === "match");
    return candidates(matches.map((entry: any) => ({ path: entry.data.path.text, line: entry.data.line_number, excerpt: entry.data.lines.text })));
  } },
  { name: "fetch-text", description: "Fetch an HTTP(S) URL. Return URL, status, and response text for a Jev decision. Does not execute page scripts.", inputSchema: { type: "string", pattern: "^https?://" }, outputSchema: { type: "object" }, run: async (input, _config, ctx) => {
    const response = await ctx.fetch(input);
    if (!response.ok) throw new Error(`Fetch returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 250000) throw new Error("Fetched document exceeds 250,000 characters; use a scoped extractor");
    return { url: response.url, status: response.status, text };
  } },
];
function candidates(items: Record<string, unknown>[]) {
  if (items.length > 254) throw new Error("More than 254 candidates: narrow the search or use a bounded per-item scoring template");
  const records = Object.fromEntries(items.map((item, i) => [`item_${i}`, item]));
  return { items, records, count: items.length, options: { ...Object.fromEntries(Object.entries(records).map(([id, item]) => [id, item])), none: "None of the supplied candidates matches; do not guess" } };
}
export class ExtractorRegistry {
  readonly entries = new Map<string, LoadedExtractor>();
  readonly diagnostics: string[] = [];
  constructor() {
    for (const definition of builtins) this.entries.set(definition.name, { definition, source: "builtin", version: "builtin-v1" });
  }
  static async load(cwd: string): Promise<ExtractorRegistry> {
    const registry = new ExtractorRegistry();
    for (const directory of [join(homedir(), ".config", "jev-agent", "extractors"), join(cwd, ".jev", "extractors")]) {
      let files: string[];
      try { files = (await readdir(directory)).filter(f => /\.(ts|js|mjs)$/.test(f)).sort(); } catch (error: any) { if (error.code !== "ENOENT") registry.diagnostics.push(String(error)); continue; }
      for (const filename of files) {
        const path = join(directory, filename);
        try {
          // Bun ignores query strings for some local-module cache paths. Bundle
          // the entry and its local dependencies to a real content-addressed path.
          const build = await Bun.build({ entrypoints: [path], target: "bun", format: "esm" });
          if (!build.success || !build.outputs[0]) throw new Error(build.logs.map(log => log.message).join("; "));
          const source = await build.outputs[0].text();
          const hash = createHash("sha256").update(source).digest("hex");
          const cache = join(cwd, ".jev", "cache", "extractors");
          await mkdir(cache, { recursive: true });
          const compiled = join(cache, `${hash}.mjs`);
          await writeFile(compiled, source);
          const definition = (await import(pathToFileURL(compiled).href)).default as Extractor;
          if (!definition || !/^[a-zA-Z][\w.-]*$/.test(definition.name) || !definition.description || typeof definition.run !== "function" || !definition.inputSchema || !definition.outputSchema) throw new Error("Export default {name,description,inputSchema,outputSchema,run}");
          ajv.compile(definition.inputSchema); ajv.compile(definition.outputSchema);
          if (definition.configSchema) ajv.compile(definition.configSchema);
          registry.entries.set(definition.name, { definition, source: path, version: hash });
        } catch (error) { registry.diagnostics.push(`${filename}: ${String(error)}`); }
      }
    }
    return registry;
  }
  catalog(): string {
    return JSON.stringify({ extractors: [...this.entries.values()].map(({ definition: d, source, version }) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, configSchema: d.configSchema, outputSchema: d.outputSchema, examples: d.examples, source, version })), diagnostics: this.diagnostics });
  }
  async run(name: string, input: unknown, config: unknown, options: { cwd: string; signal: AbortSignal; artifactDir: string; onActivity: (data: Record<string, unknown>) => void }): Promise<unknown> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown extractor ${name}; reload between graph calls. ${this.diagnostics.join("; ")}`);
    const check = (schema: Record<string, any>, value: unknown, label: string) => {
      const validator = ajv.compile(schema);
      if (!validator(value)) throw new Error(`${name} ${label}: ${ajv.errorsText(validator.errors)}`);
    };
    check(entry.definition.inputSchema, input, "input");
    if (entry.definition.configSchema) check(entry.definition.configSchema, config ?? {}, "config");
    options.signal.throwIfAborted();
    const context: PluginContext = {
      cwd: options.cwd, signal: options.signal,
      exec: (script, extra = {}) => {
        options.onActivity({ operation: "exec", script, extractor: name });
        return runCommand({ ...extra, script, cwd: extra.cwd ? resolveWithinWorkspace(options.cwd, extra.cwd) : options.cwd, signal: options.signal, outputPrefix: join(options.artifactDir, `plugin-${randomUUID()}`) });
      },
      fetch: async (url, init = {}) => {
        options.onActivity({ operation: "fetch", url, extractor: name });
        return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal });
      },
      artifact: async data => { const path = join(options.artifactDir, `plugin-${randomUUID()}.json`); await mkdir(options.artifactDir, { recursive: true }); await writeFile(path, JSON.stringify(data, null, 2)); return path; },
      log: message => options.onActivity({ operation: "log", message, extractor: name }),
    };
    options.onActivity({ operation: "start", extractor: name, version: entry.version });
    const output = await entry.definition.run(input, config ?? {}, context);
    options.signal.throwIfAborted();
    check(entry.definition.outputSchema, output, "output");
    // JSON round-trip prohibits live objects/functions from leaking into graph state.
    const serialized = JSON.stringify(output);
    if (serialized === undefined) throw new Error(`${name} returned a non-JSON value`);
    return JSON.parse(serialized);
  }
}
