import { resolve } from "node:path";
import { version } from "../../package.json";
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_GRAPH_LIMITS, DEFAULT_JEV_MODEL, DEFAULT_SYNTH_MODEL, PLANNER_CONTRACT_VERSION } from "../core/runtime-contract.ts";

/** Only explicitly selected capabilities belong here. Never serialize the environment. */
export function runtimeContext(cwd: string, demo = false, env: NodeJS.ProcessEnv = process.env) {
  return {
    runtime: { name: "Jive", version, plannerContractVersion: PLANNER_CONTRACT_VERSION, graphVersion: 1 },
    cwd: resolve(cwd),
    bash: { executable: "bash", separateProcessPerNode: true, defaultTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
    jev: {
      mode: demo ? "fixture" : "remote",
      credentialsConfigured: demo || Boolean(env.JEV_API_TOKEN || env.TYPESAFE_API_KEY),
      model: demo ? "fixture" : env.JEV_MODEL ?? DEFAULT_JEV_MODEL,
      availability: demo ? "local fixture" : "Configuration only; service availability is established by task calls.",
    },
    synth: {
      mode: demo ? "unavailable" : "remote",
      credentialsConfigured: Boolean(env.OPENROUTER_API_KEY),
      defaultModel: env.JIVE_SYNTH_MODEL ?? DEFAULT_SYNTH_MODEL,
      contract: "Tool-less bounded generation from task+input supplied by the graph; no repository exploration.",
    },
    defaultGraphLimits: DEFAULT_GRAPH_LIMITS,
    execution: { parallelNodes: true, serialToolInvocations: true, streamingGraphs: true },
    savedGraphs: {
      directory: ".jev/runs/<graphId>/",
      unchanged: { tool: "execute_graph_mod", arguments: { base: "<graphId>" } },
      file: { tool: "execute_graph_mod", arguments: { file: "work/graph.json" } },
      standalone: { program: "jive", args: ["--cwd", resolve(cwd), "--run", "work/graph.json", "--json"] },
      semantics: "All nodes run again; files persist. Source graphs are unchanged. Node cwd defaults to session cwd, including file replay.",
    },
    extractors: "Use the latest Extractor plugin catalog update; it is refreshed between graph calls and retained through compaction.",
  };
}

export function runtimeContextMessage(context: ReturnType<typeof runtimeContext>): string {
  return `Runtime capabilities supplied by Jive (authoritative for this request):\n${JSON.stringify(context)}\nUse configured capabilities directly for task work. Credentials are managed by the runtime; do not print environment variables or credential values to discover configuration.`;
}
