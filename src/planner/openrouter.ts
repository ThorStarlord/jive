import type { PlannerMessage, PlannerToolCall } from "../session/types.ts";
import { cacheConfigurationForModel } from "./models.ts";

/**
 * Explicit thinking budgets for Anthropic models, by effort level. OpenRouter turns
 * reasoning.effort into a percentage of max_tokens for these models, and this client
 * never sets max_tokens, so even "low" became a five-figure budget that Claude used
 * freely. A fixed reasoning.max_tokens makes each level mean something.
 */
export const ANTHROPIC_REASONING_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 24576,
  max: 32768,
};

/** The reasoning object for one request, or undefined to leave the provider default. */
export function reasoningParameters(model: string, effort: string | undefined): Record<string, unknown> | undefined {
  if (!effort) return undefined;
  if (model.startsWith("anthropic/")) {
    if (effort === "none") return { enabled: false };
    const budget = ANTHROPIC_REASONING_BUDGETS[effort];
    if (budget !== undefined) return { max_tokens: budget };
  }
  return { effort };
}

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export interface OpenRouterCompletion {
  message: PlannerMessage;
  usage: OpenRouterUsage;
  model: string;
  provider?: string;
  finishReason?: string;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  appUrl?: string;
  appName?: string;
  retry?: Partial<RetryPolicy>;
}

export interface CompleteOptions {
  model: string;
  sessionId: string;
  messages: readonly PlannerMessage[];
  /** One function definition or several; omit for a tool-less bounded completion. */
  toolSchema?: Record<string, unknown> | Record<string, unknown>[];
  /** Optional provider output-token ceiling, used by bounded synthesis. */
  maxTokens?: number;
  effort?: string;
  signal?: AbortSignal;
  onContent?: (delta: string) => void;
  /** Called with each reasoning delta, or with no text when only opaque details arrived. */
  onReasoning?: (delta?: string) => void;
  onToolCall?: (delta: ToolCallDelta) => void | Promise<void>;
  /** Called before each retry of a transient failure; nothing has reached the callbacks above. */
  onRetry?: (notice: RetryNotice) => void;
  retry?: Partial<RetryPolicy>;
}

export interface ToolCallDelta {
  index: number;
  id: string;
  name: string;
  arguments: string;
  argumentsDelta: string;
}

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export class OpenRouterError extends Error {
  readonly status?: number;
  readonly details?: unknown;
  /** Set when the same request could plausibly succeed on a second attempt. */
  readonly retryable: boolean;
  /** A delay the provider asked for, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { status?: number; details?: unknown; cause?: unknown; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenRouterError";
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Statuses that describe congestion or a provider hiccup rather than a bad request. */
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
/** Wording providers use for the same conditions when they arrive inside the stream. */
const TRANSIENT_TEXT = /rate.?limit|temporarily|overloaded|capacity|timed? ?out|timeout|try again|unavailable|upstream|internal server error|connection (?:reset|closed)|socket hang up|network|fetch failed/i;
const MAX_HONOURED_RETRY_AFTER_MS = 30_000;

export interface RetryPolicy {
  /** Total attempts including the first; 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };

export interface RetryNotice {
  attempt: number;
  attempts: number;
  delayMs: number;
  /** Two or three words for a status line, e.g. "rate limited". */
  reason: string;
  error: OpenRouterError;
}

/** A mid-stream error payload: the provider's own code decides, and its wording otherwise. */
function transientPayload(payload: unknown, message: string): boolean {
  const code = payload && typeof payload === "object" ? (payload as Record<string, unknown>).code : undefined;
  const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : undefined;
  if (numeric !== undefined) return TRANSIENT_STATUS.has(numeric);
  return TRANSIENT_TEXT.test(message);
}

/** `Retry-After` in seconds or as an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function retryReason(error: OpenRouterError): string {
  if (error.status === 429 || /rate.?limit/i.test(error.message)) return "rate limited";
  if (error.status !== undefined && error.status >= 500) return `provider error ${error.status}`;
  if (/Could not reach OpenRouter/.test(error.message)) return "network error";
  if (/stream/i.test(error.message)) return "stream interrupted";
  return "transient error";
}

/** How long to wait before attempt `attempt + 1`, or undefined when the error must stand. */
export function retryDelay(error: unknown, attempt: number, policy: RetryPolicy): number | undefined {
  if (!(error instanceof OpenRouterError) || !error.retryable) return undefined;
  if (attempt >= policy.attempts) return undefined;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  // Jitter keeps several sessions from returning to a busy provider in lockstep.
  const jittered = Math.round(backoff * (0.7 + Math.random() * 0.6));
  const asked = Math.min(error.retryAfterMs ?? 0, MAX_HONOURED_RETRY_AFTER_MS);
  return Math.max(asked, jittered);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeUsage(value: unknown): OpenRouterUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const number = (candidate: unknown) => typeof candidate === "number" ? candidate : 0;
  return {
    promptTokens: number(usage.prompt_tokens),
    completionTokens: number(usage.completion_tokens),
    totalTokens: number(usage.total_tokens),
    cachedTokens: number(details.cached_tokens),
    cacheWriteTokens: number(details.cache_write_tokens),
  };
}

/** Standards-compliant enough for CRLF, comments, split chunks and multi-line data. */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let firstLine = true;

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") {
      if (dataLines.length === 0) {
        eventName = undefined;
        return undefined;
      }
      const event = { ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") };
      dataLines = [];
      eventName = undefined;
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    if (field === "event") eventName = value;
    return undefined;
  };

  const takeLine = (atEnd: boolean): string | undefined => {
    let boundary = -1;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === "\n" || buffer[index] === "\r") {
        boundary = index;
        break;
      }
    }
    if (boundary < 0) return undefined;
    if (buffer[boundary] === "\r" && boundary === buffer.length - 1 && !atEnd) {
      return undefined;
    }
    const line = buffer.slice(0, boundary);
    const width = buffer[boundary] === "\r" && buffer[boundary + 1] === "\n" ? 2 : 1;
    buffer = buffer.slice(boundary + width);
    if (firstLine) {
      firstLine = false;
      return line.startsWith("\uFEFF") ? line.slice(1) : line;
    }
    return line;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const line = takeLine(false);
        if (line === undefined) break;
        const event = consumeLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    while (true) {
      const line = takeLine(true);
      if (line === undefined) break;
      const event = consumeLine(line);
      if (event) yield event;
    }
    if (buffer) {
      let line = buffer;
      buffer = "";
      if (firstLine && line.startsWith("\uFEFF")) line = line.slice(1);
      firstLine = false;
      const event = consumeLine(line);
      if (event) yield event;
    }
    const finalEvent = consumeLine("");
    if (finalEvent) yield finalEvent;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function apiMessage(message: PlannerMessage, model: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.name) result.name = message.name;
  if (message.tool_call_id) result.tool_call_id = message.tool_call_id;
  if (message.tool_calls) result.tool_calls = message.tool_calls;
  // Reasoning blocks are provider/model state. They must be passed back
  // unmodified during a tool round, but not leaked into another model.
  if (!message.model || message.model === model) {
    if (message.reasoning !== undefined) result.reasoning = message.reasoning;
    if (message.reasoning_details !== undefined) result.reasoning_details = message.reasoning_details;
  }
  return result;
}

interface ToolAccumulator {
  index: number;
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

function appendFragment(current: string, fragment: unknown): string {
  if (typeof fragment !== "string" || !fragment) return current;
  return current + fragment;
}

export class OpenRouterClient {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly fetch: typeof globalThis.fetch;
  readonly appUrl?: string;
  readonly appName?: string;
  readonly retry: RetryPolicy;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.appUrl = options.appUrl;
    this.appName = options.appName;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  /**
   * One completion, retrying transient failures.
   *
   * A retry replays the whole request, so it is only safe while nothing has reached the
   * caller: a reasoning or content delta is already on screen, and a tool-call delta may
   * already have committed a graph to execution. Once any of them has been handed over,
   * the failure is the turn's, and the planner decides what to do with the evidence.
   */
  async complete(options: CompleteOptions): Promise<OpenRouterCompletion> {
    const policy: RetryPolicy = { ...this.retry, ...options.retry };
    for (let attempt = 1; ; attempt += 1) {
      let handedOver = false;
      try {
        return await this.#attempt(options, () => { handedOver = true; });
      } catch (error) {
        options.signal?.throwIfAborted();
        const delay = handedOver ? undefined : retryDelay(error, attempt, policy);
        if (delay === undefined) throw error;
        const failure = error as OpenRouterError;
        options.onRetry?.({ attempt, attempts: policy.attempts, delayMs: delay, reason: retryReason(failure), error: failure });
        await wait(delay, options.signal);
      }
    }
  }

  async #attempt(options: CompleteOptions, handOver: () => void): Promise<OpenRouterCompletion> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.appUrl ? { "HTTP-Referer": this.appUrl } : {}),
          ...(this.appName ? { "X-Title": this.appName } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          session_id: options.sessionId.slice(0, 256),
          messages: options.messages.map((message) => apiMessage(message, options.model)),
          ...(options.toolSchema ? {
            tools: (Array.isArray(options.toolSchema) ? options.toolSchema : [options.toolSchema])
              .map((schema) => ({ type: "function", function: schema })),
            tool_choice: "auto",
          } : {}),
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
          provider: { allow_fallbacks: false },
          ...(reasoningParameters(options.model, options.effort)
            ? { reasoning: reasoningParameters(options.model, options.effort) }
            : {}),
          ...cacheConfigurationForModel(options.model),
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new OpenRouterError(
        `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      const raw = await response.text();
      let details: unknown = raw.slice(0, 4_000);
      try { details = JSON.parse(raw); } catch { /* keep bounded text */ }
      const remoteMessage = details && typeof details === "object" && "error" in details
        ? JSON.stringify((details as Record<string, unknown>).error)
        : raw.slice(0, 500);
      throw new OpenRouterError(
        `OpenRouter request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${remoteMessage || "empty response"}`,
        {
          status: response.status,
          details,
          retryable: TRANSIENT_STATUS.has(response.status),
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        },
      );
    }
    if (!response.body) throw new OpenRouterError("OpenRouter returned an empty streaming response.");

    let content = "";
    let reasoning = "";
    let reasoningDetails: unknown[] | undefined;
    let usage = normalizeUsage(undefined);
    let returnedModel = options.model;
    let provider: string | undefined;
    let finishReason: string | undefined;
    const calls = new Map<number, ToolAccumulator>();
    let done = false;

    try {
      for await (const event of parseServerSentEvents(response.body)) {
        if (event.data.trim() === "[DONE]") {
          done = true;
          break;
        }
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(event.data) as Record<string, any>;
        } catch (error) {
          throw new OpenRouterError("OpenRouter sent malformed SSE JSON.", {
            details: event.data.slice(0, 1_000),
            cause: error,
            retryable: true,
          });
        }
        if (chunk.error || event.event === "error") {
          const reported = typeof chunk.error?.message === "string" ? chunk.error.message : JSON.stringify(chunk.error ?? chunk);
          const code = typeof chunk.error?.code === "number" ? chunk.error.code : undefined;
          throw new OpenRouterError(`OpenRouter stream failed: ${reported}`, {
            details: chunk.error ?? chunk,
            ...(code !== undefined ? { status: code } : {}),
            retryable: transientPayload(chunk.error, reported),
          });
        }
        if (typeof chunk.model === "string") returnedModel = chunk.model;
        if (typeof chunk.provider === "string") provider = chunk.provider;
        if (chunk.usage) usage = normalizeUsage(chunk.usage);

        for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
          if (typeof delta.content === "string") {
            content += delta.content;
            if (delta.content) handOver();
            options.onContent?.(delta.content);
          }
          let reasoningActivity = false;
          if (typeof delta.reasoning === "string") {
            reasoning += delta.reasoning;
            reasoningActivity = true;
            if (delta.reasoning) handOver();
            options.onReasoning?.(delta.reasoning);
          }
          if (delta.reasoning_details !== undefined) {
            reasoningDetails ??= [];
            if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
            else reasoningDetails.push(delta.reasoning_details);
            reasoningActivity = true;
          }
          if (reasoningActivity && typeof delta.reasoning !== "string") options.onReasoning?.();
          for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = typeof fragment.index === "number" ? fragment.index : calls.size;
            const accumulator = calls.get(index) ?? {
              index,
              id: "",
              type: "function" as const,
              name: "",
              arguments: "",
            };
            accumulator.id = appendFragment(accumulator.id, fragment.id);
            accumulator.name = appendFragment(accumulator.name, fragment.function?.name);
            accumulator.arguments = appendFragment(accumulator.arguments, fragment.function?.arguments);
            calls.set(index, accumulator);
            handOver();
            await options.onToolCall?.({
              index, id: accumulator.id, name: accumulator.name,
              arguments: accumulator.arguments,
              argumentsDelta: typeof fragment.function?.arguments === "string" ? fragment.function.arguments : "",
            });
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (error instanceof OpenRouterError) throw error;
      throw new OpenRouterError(
        `OpenRouter stream was interrupted: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, retryable: true },
      );
    }

    if (!done && options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!done && !finishReason) {
      throw new OpenRouterError("OpenRouter stream ended before a completion marker.", { retryable: true });
    }
    if (finishReason === "length" || finishReason === "content_filter" || finishReason === "error") {
      throw new OpenRouterError(`OpenRouter completion ended with ${finishReason} before the requested completion finished.`);
    }
    if (calls.size > 0 && finishReason !== "tool_calls" && finishReason !== "stop") {
      throw new OpenRouterError("OpenRouter did not confirm completion of the tool calls.");
    }
    if (calls.size === 0 && !content.trim()) {
      throw new OpenRouterError("OpenRouter returned no answer or tool call.", { retryable: true });
    }
    const toolCalls: PlannerToolCall[] = [...calls.values()]
      .sort((left, right) => left.index - right.index)
      .map((call, index) => ({
        id: call.id || `tool-call-${index}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    const message: PlannerMessage = {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
      // Keep the requested ID on the message so opaque reasoning state is
      // returned only while continuing with that same selected model. The
      // resolved ID is retained separately on OpenRouterCompletion.
      model: options.model,
      ...(provider ? { provider } : {}),
    };
    return { message, usage, model: returnedModel, ...(provider ? { provider } : {}), ...(finishReason ? { finishReason } : {}) };
  }
}
