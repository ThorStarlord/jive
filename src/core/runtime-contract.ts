import type { Limits } from "./types.ts";

export const PLANNER_CONTRACT_VERSION = "3";
export const DEFAULT_GRAPH_LIMITS: Readonly<Limits> = Object.freeze({
  concurrency: 6, timeoutMs: 300000, maxJevCalls: 100, maxSynthCalls: 100,
});
export const DEFAULT_COMMAND_TIMEOUT_MS = 60000;
export const DEFAULT_JEV_MODEL = "jev-1.13.0";
export const DEFAULT_SYNTH_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_SYNTH_MAX_OUTPUT_TOKENS = 4096;
export const MAX_SYNTH_INPUT_TOKENS = 64000;
