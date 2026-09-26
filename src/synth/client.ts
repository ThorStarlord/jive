import { randomUUID } from "node:crypto";
import { OpenRouterClient, type RetryPolicy } from "../planner/openrouter.ts";
import {
  DEFAULT_SYNTH_MODEL,
} from "../core/runtime-contract.ts";
import type { PlannerMessage } from "../session/types.ts";
import type { SynthAdapter, SynthRequest, SynthResponse } from "../core/types.ts";

export interface OpenRouterSynthClientOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  retry?: Partial<RetryPolicy>;
}

/**
 * Tool-less bounded generation for graph synth nodes.
 *
 * The worker receives only the task and evidence explicitly resolved by the graph.
 * It cannot inspect the repository or call tools, which keeps synthesis cost and
 * authority separate from reconnaissance and execution.
 */
export class OpenRouterSynthClient implements SynthAdapter {
  readonly options: OpenRouterSynthClientOptions;

  constructor(options: OpenRouterSynthClientOptions = {}) {
    this.options = options;
  }

  async generate(request: SynthRequest, signal?: AbortSignal): Promise<SynthResponse> {
    const apiKey = this.options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for synth nodes.");

    const model = request.model ?? process.env.JIVE_SYNTH_MODEL ?? DEFAULT_SYNTH_MODEL;
    const client = new OpenRouterClient({
      apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.retry ? { retry: this.options.retry } : {}),
    });
    const messages: PlannerMessage[] = [
      {
        role: "system",
        content: [
          "You are a bounded synthesis worker inside Jive.",
          "You have no tools and cannot inspect files, run commands, browse, or acquire more context.",
          "Use only the supplied task and input. Do not invent missing repository facts.",
          request.outputFormat === "json"
            ? "Return exactly one valid JSON value and no markdown fences or commentary."
            : "Return only the requested synthesized text.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Task:\n${request.task}\n\nInput JSON:\n${JSON.stringify(request.input) ?? "null"}`,
      },
    ];

    const completion = await client.complete({
      model,
      sessionId: `synth-${randomUUID()}`,
      messages,
      maxTokens: request.maxOutputTokens,
      effort: request.effort,
      signal,
    });
    const text = completion.message.content?.trim() ?? "";
    if (!text) throw new Error("Synthesis model returned no content.");

    if (request.outputFormat === "json") {
      let json: unknown;
      try { json = JSON.parse(text); }
      catch (error) {
        throw new Error(`Synthesis output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        model: completion.model,
        ...(completion.provider ? { provider: completion.provider } : {}),
        text,
        json,
        usage: completion.usage,
      };
    }

    return {
      model: completion.model,
      ...(completion.provider ? { provider: completion.provider } : {}),
      text,
      usage: completion.usage,
    };
  }
}
