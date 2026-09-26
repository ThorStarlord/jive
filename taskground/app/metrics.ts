import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "./runner.ts";

export interface RunMetricPoint {
  time: number;
  active: number;
  steps: number;
  jevCalls: number;
  synthCalls: number;
}

export interface RunMetrics {
  elapsedMs: number;
  plannerTurns: number | null;
  steps: number | null;
  graphsStarted: number | null;
  graphsCompleted: number | null;
  graphsFailed: number | null;
  avgGraphSize: number | null;
  jevCalls: number | null;
  synthCalls: number | null;
  jevAttempts: number | null;
  jevRetries: number | null;
  currentParallelism: number | null;
  peakParallelism: number | null;
  avgParallelism: number | null;
  repeatIterations: number | null;
  foreachItems: number | null;
  lastEventAt: number | null;
  series: RunMetricPoint[];
  available: boolean;
}

export interface AggregateOptions {
  now?: number;
  elapsedMs?: number;
  /** Close unfinished graph/node intervals at this immutable terminal-run boundary. */
  terminalAt?: number;
  /** An existing, even empty, telemetry file means zero attempts rather than unknown attempts. */
  attemptTelemetryAvailable?: boolean;
}

type JsonRecord = Record<string, any>;
type LeafType = "bash" | "jev" | "synth";
type EventSource = "session" | "raw";

interface GraphState {
  id: string;
  source: EventSource;
  startedAt?: number;
  finishedAt?: number;
  status?: string;
}

interface NodeState {
  graphId: string;
  source: EventSource;
  id: string;
  type?: string;
  startedAt?: number;
  finishedAt?: number;
  status?: string;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const numeric = finite(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function leaf(type: unknown): type is LeafType { return type === "bash" || type === "jev" || type === "synth"; }

class MetricReducer {
  readonly executionKeys = new Set<string>();
  readonly sessionKeys = new Set<string>();
  readonly graphs = new Map<string, GraphState>();
  readonly nodes = new Map<string, NodeState>();
  readonly groupTypes = new Map<string, string>();
  readonly sessionGraphs = new Set<string>();
  readonly jevRequests: Array<{ graphId: string; source: EventSource; time: number }> = [];
  readonly synthRequests: Array<{ graphId: string; source: EventSource; time: number }> = [];
  plannerTurns = 0;
  jevAttempts = 0;
  jevRetries = 0;
  attemptTelemetryAvailable = false;
  executionAvailable = false;
  lastEventAt: number | undefined;

  ingest(input: unknown, explicitSource?: EventSource): void {
    if (!record(input)) return;
    this.lastEventAt = maxDefined(this.lastEventAt, timestamp(input.timestamp));
    if ((input.type === "attempt" || input.type === "retry") && finite(input.time) !== undefined) {
      this.attemptTelemetryAvailable = true;
      this.executionAvailable = true;
      input.type === "attempt" ? this.jevAttempts++ : this.jevRetries++;
      this.lastEventAt = maxDefined(this.lastEventAt, input.time);
      return;
    }

    if (input.type === "planner.request") {
      const key = typeof input.id === "string" ? input.id : `planner:${input.sequence ?? ""}:${input.timestamp ?? ""}`;
      if (this.sessionKeys.has(key)) return;
      this.sessionKeys.add(key);
      this.executionAvailable = true;
      this.plannerTurns++;
      this.lastEventAt = maxDefined(this.lastEventAt, timestamp(input.timestamp));
      return;
    }

    // Only the nested execution event is authoritative. Session graph/stream wrappers mirror it.
    const nested = input.type === "execution.event" && record(input.data) && record(input.data.event);
    const event = nested ? input.data.event : input;
    this.ingestExecution(event, explicitSource ?? (nested ? "session" : "raw"));
  }

  private ingestExecution(event: JsonRecord, source: EventSource): void {
    if (typeof event.graphId !== "string" || typeof event.type !== "string") return;
    const eventTime = finite(event.time);
    this.lastEventAt = maxDefined(this.lastEventAt, eventTime);
    const relevant = event.type === "graph.started" || event.type === "graph.finished" ||
      event.type === "node.created" || event.type === "node.started" || event.type === "node.finished" ||
      event.type === "jev.request" || event.type === "synth.request";
    if (!relevant) return;
    // Once the durable session has the runtime's graph.started event, its remapped sequence space
    // is authoritative for that graph. Raw events remain retained solely as a fallback.
    if (source === "session" && event.type === "graph.started") this.sessionGraphs.add(event.graphId);
    const sequence = finite(event.sequence);
    const key = sequence !== undefined
      ? `${source}\0${event.graphId}\0${sequence}`
      : `${source}\0${event.graphId}\0${event.type}\0${event.nodeId ?? ""}\0${eventTime ?? ""}`;
    if (this.executionKeys.has(key)) return;
    this.executionKeys.add(key);

    this.executionAvailable = true;
    this.lastEventAt = maxDefined(this.lastEventAt, eventTime);

    const graphKey = `${source}\0${event.graphId}`;
    let graph = this.graphs.get(graphKey);
    if (!graph) {
      graph = { id: event.graphId, source };
      this.graphs.set(graphKey, graph);
    }
    if (event.type === "graph.started") {
      graph.startedAt = minDefined(graph.startedAt, eventTime);
      return;
    }
    if (event.type === "graph.finished") {
      graph.finishedAt = maxDefined(graph.finishedAt, eventTime);
      const report = record(event.data?.report) ? event.data.report : undefined;
      graph.status = typeof report?.status === "string" ? report.status
        : typeof event.data?.status === "string" ? event.data.status : graph.status;
      return;
    }
    if (event.type === "jev.request") {
      if (eventTime !== undefined) this.jevRequests.push({ graphId: event.graphId, source, time: eventTime });
      return;
    }
    if (event.type === "synth.request") {
      if (eventTime !== undefined) this.synthRequests.push({ graphId: event.graphId, source, time: eventTime });
      return;
    }
    if (typeof event.nodeId !== "string") return;
    const nodeKey = `${source}\0${event.graphId}\0${event.nodeId}`;
    let node = this.nodes.get(nodeKey);
    if (!node) {
      node = { graphId: event.graphId, source, id: event.nodeId };
      this.nodes.set(nodeKey, node);
    }
    const result = record(event.data?.result) ? event.data.result : undefined;
    const type = result?.type ?? event.data?.type;
    if (typeof type === "string") node.type = type;
    if (event.type === "node.created" && (type === "foreach" || type === "repeat")) {
      this.groupTypes.set(nodeKey, type);
    }
    if (event.type === "node.started") node.startedAt = minDefined(node.startedAt, eventTime);
    if (event.type === "node.finished") {
      node.startedAt = minDefined(node.startedAt, finite(result?.startedAt));
      node.finishedAt = maxDefined(node.finishedAt, finite(result?.finishedAt) ?? eventTime);
      if (typeof result?.status === "string") node.status = result.status;
    }
  }

  finish(options: AggregateOptions = {}): RunMetrics {
    const now = options.now ?? Date.now();
    const boundary = options.terminalAt ?? now;
    const selected = (graphId: string, source: EventSource) => this.sessionGraphs.has(graphId) ? source === "session" : source === "raw";
    const graphs = [...this.graphs.values()].filter(graph =>
      selected(graph.id, graph.source) && graph.startedAt !== undefined && graph.startedAt <= boundary);
    const leafNodes = [...this.nodes.values()].filter(node =>
      selected(node.graphId, node.source) && leaf(node.type) && node.startedAt !== undefined && node.startedAt <= boundary);
    const graphById = new Map(graphs.map(graph => [graph.id, graph]));

    const graphIntervals = graphs.map(graph => ({
      start: graph.startedAt!,
      end: Math.max(graph.startedAt!, Math.min(graph.finishedAt ?? boundary, boundary)),
    }));
    const nodeIntervals = leafNodes.map(node => {
      const graphEnd = graphById.get(node.graphId)?.finishedAt;
      let end = node.finishedAt ?? graphEnd ?? boundary;
      if (graphEnd !== undefined) end = Math.min(end, graphEnd);
      end = Math.min(end, boundary);
      return {
        start: node.startedAt!, end: Math.max(node.startedAt!, end),
        open: options.terminalAt === undefined && node.finishedAt === undefined && graphEnd === undefined,
      };
    });
    const parallel = concurrency(graphIntervals, nodeIntervals);
    const current = options.terminalAt === undefined
      ? nodeIntervals.filter(interval => interval.open && interval.start <= boundary).length : 0;
    const finishedGraphs = graphs.filter(graph => graph.finishedAt !== undefined);
    const graphSizes = finishedGraphs.map(graph => leafNodes.filter(node => node.graphId === graph.id).length);
    const completed = finishedGraphs.filter(graph => graph.status === "done").length;
    const failed = finishedGraphs.filter(graph => graph.status !== "done").length +
      (options.terminalAt === undefined ? 0 : graphs.filter(graph => graph.finishedAt === undefined).length);
    const { repeatIterations, foreachItems } = this.loopCounts(leafNodes);
    const jevRequestTimes = this.jevRequests
      .filter(request => selected(request.graphId, request.source) && request.time <= boundary)
      .map(request => request.time);
    const synthRequestTimes = this.synthRequests
      .filter(request => selected(request.graphId, request.source) && request.time <= boundary)
      .map(request => request.time);
    const series = metricSeries(graphIntervals, nodeIntervals, jevRequestTimes, synthRequestTimes);
    const available = this.executionAvailable;
    const telemetry = options.attemptTelemetryAvailable || this.attemptTelemetryAvailable;

    return {
      elapsedMs: Math.max(0, options.elapsedMs ?? 0),
      plannerTurns: available ? this.plannerTurns : null,
      steps: available ? leafNodes.length : null,
      graphsStarted: available ? graphs.length : null,
      graphsCompleted: available ? completed : null,
      graphsFailed: available ? failed : null,
      avgGraphSize: graphSizes.length ? graphSizes.reduce((sum, size) => sum + size, 0) / graphSizes.length : null,
      jevCalls: available ? jevRequestTimes.length : null,
      synthCalls: available ? synthRequestTimes.length : null,
      jevAttempts: telemetry ? this.jevAttempts : null,
      jevRetries: telemetry ? this.jevRetries : null,
      currentParallelism: available ? current : null,
      peakParallelism: available ? parallel.peak : null,
      avgParallelism: graphIntervals.length ? parallel.average : null,
      repeatIterations: available ? repeatIterations : null,
      foreachItems: available ? foreachItems : null,
      lastEventAt: this.lastEventAt ?? null,
      series: available ? series : [],
      available,
    };
  }

  private loopCounts(nodes: NodeState[]): { repeatIterations: number; foreachItems: number } {
    const repeat = new Set<string>(), foreach = new Set<string>();
    for (const node of nodes) {
      // Each prefix identifies an instantiated group, including nested groups. A Set prevents
      // every body node in the same iteration from incrementing the metric again.
      const pattern = /(?:^|\/)([^/]+)\[(\d+)\](?=\/|$)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(node.id))) {
        const instanceEnd = match.index + match[0].length;
        const instance = node.id.slice(0, instanceEnd);
        const groupId = instance.replace(/\[\d+\]$/, "");
        const type = this.groupTypes.get(`${node.source}\0${node.graphId}\0${groupId}`);
        if (type === "repeat") repeat.add(`${node.graphId}\0${instance}`);
        if (type === "foreach") foreach.add(`${node.graphId}\0${instance}`);
      }
    }
    return { repeatIterations: repeat.size, foreachItems: foreach.size };
  }
}

function concurrency(
  graphIntervals: Array<{ start: number; end: number }>,
  nodeIntervals: Array<{ start: number; end: number }>,
): { current: number; peak: number; average: number } {
  const points = new Map<number, { graphs: number; nodes: number }>();
  const add = (time: number, field: "graphs" | "nodes", amount: number) => {
    const point = points.get(time) ?? { graphs: 0, nodes: 0 };
    point[field] += amount;
    points.set(time, point);
  };
  for (const interval of graphIntervals) {
    add(interval.start, "graphs", 1);
    add(interval.end, "graphs", -1);
  }
  for (const interval of nodeIntervals) {
    add(interval.start, "nodes", 1);
    add(interval.end, "nodes", -1);
  }
  let graphDepth = 0, active = 0, peak = 0, wall = 0, weighted = 0;
  let previous: number | undefined;
  for (const [time, delta] of [...points].sort(([a], [b]) => a - b)) {
    if (previous !== undefined && time > previous && graphDepth > 0) {
      const duration = time - previous;
      wall += duration;
      weighted += active * duration;
    }
    graphDepth += delta.graphs;
    active += delta.nodes;
    if (graphDepth > 0) peak = Math.max(peak, active);
    previous = time;
  }
  return { current: Math.max(0, active), peak, average: wall ? weighted / wall : 0 };
}

function metricSeries(
  graphIntervals: Array<{ start: number; end: number }>,
  nodeIntervals: Array<{ start: number; end: number; open?: boolean }>,
  jevTimes: number[],
  synthTimes: number[],
): RunMetricPoint[] {
  const changes = new Map<number, { active: number; steps: number; jev: number; synth: number }>();
  const add = (time: number, active: number, steps: number, jev: number, synth: number) => {
    const change = changes.get(time) ?? { active: 0, steps: 0, jev: 0, synth: 0 };
    change.active += active; change.steps += steps; change.jev += jev; change.synth += synth;
    changes.set(time, change);
  };
  for (const interval of graphIntervals) {
    add(interval.start, 0, 0, 0, 0);
    add(interval.end, 0, 0, 0, 0);
  }
  for (const interval of nodeIntervals) {
    add(interval.start, 1, 1, 0, 0);
    if (!interval.open) add(interval.end, -1, 0, 0, 0);
  }
  for (const time of jevTimes) add(time, 0, 0, 1, 0);
  for (const time of synthTimes) add(time, 0, 0, 0, 1);
  let active = 0, steps = 0, jevCalls = 0, synthCalls = 0;
  const all = [...changes].sort(([a], [b]) => a - b).map(([time, change]) => {
    active += change.active; steps += change.steps; jevCalls += change.jev; synthCalls += change.synth;
    return { time, active: Math.max(0, active), steps, jevCalls, synthCalls };
  });
  if (all.length <= 256) return all;
  const sampled = [all[0]!];
  for (let index = 1; index < 255; index++) sampled.push(all[Math.floor(index * (all.length - 1) / 255)]!);
  sampled.push(all.at(-1)!);
  return sampled;
}

/** Pure aggregation helper used by tests and offline consumers. */
export function aggregate(records: readonly unknown[], options: AggregateOptions | number = {}): RunMetrics {
  const normalized = typeof options === "number" ? { now: options } : options;
  const reducer = new MetricReducer();
  for (const entry of records) reducer.ingest(entry);
  return reducer.finish(normalized);
}

interface FileCursor { offset: number; remainder: Buffer }
interface RunCache {
  files: Map<string, FileCursor>;
  reducer: MetricReducer;
  native: NativeReducer;
}

const caches = new Map<string, RunCache>();
const pollTails = new Map<string, Promise<void>>();

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
}

async function existing(path: string): Promise<boolean> {
  return stat(path).then(value => value.isFile(), () => false);
}

async function readIncremental(path: string, cache: RunCache, consume: (value: unknown, modified: number) => void): Promise<"ok" | "missing" | "truncated"> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return "missing";
  const cursor = cache.files.get(path) ?? { offset: 0, remainder: Buffer.alloc(0) };
  if (info.size < cursor.offset) return "truncated";
  if (info.size === cursor.offset) return "ok";
  const file = await open(path, "r");
  try {
    const parse = (line: Buffer): boolean => {
      if (!line.length) return true;
      try { consume(JSON.parse(line.toString("utf8")), info.mtimeMs); return true; }
      catch { return false; /* A diagnostic log line is not metrics. */ }
    };
    while (cursor.offset < info.size) {
      const length = Math.min(256 * 1024, info.size - cursor.offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, cursor.offset);
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      const data = cursor.remainder.length
        ? Buffer.concat([cursor.remainder, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let start = 0, newline: number;
      while ((newline = data.indexOf(10, start)) !== -1) {
        parse(data.subarray(start, newline));
        start = newline + 1;
      }
      cursor.remainder = Buffer.from(data.subarray(start));
    }
    // JSONL permits the final record to omit a newline. Keep incomplete JSON for the next poll.
    if (parse(cursor.remainder)) cursor.remainder = Buffer.alloc(0);
    cache.files.set(path, cursor);
    return "ok";
  } finally { await file.close(); }
}

class NativeReducer {
  available = false;
  plannerTurns = 0;
  readonly turns = new Set<string>();
  readonly steps = new Set<string>();
  lastEventAt: number | undefined;
  sequence = 0;

  ingest(value: unknown, modified: number): void {
    if (!record(value) || typeof value.type !== "string") return;
    const index = this.sequence++;
    if (["thread.started", "turn.started", "turn.completed", "item.started", "item.completed"].includes(value.type)) {
      this.available = true;
      if (value.type === "turn.started") {
        const key = String(value.turn_id ?? value.id ?? index);
        if (!this.turns.has(key)) { this.turns.add(key); this.plannerTurns++; }
      }
      if ((value.type === "item.started" || value.type === "item.completed") && record(value.item)) {
        const kind = value.item.type;
        if (!["agent_message", "reasoning", "plan"].includes(kind)) this.steps.add(String(value.item.id ?? `${kind}:${index}`));
      }
      this.lastEventAt = maxDefined(this.lastEventAt, modified);
      return;
    }
    if (["system", "assistant", "user", "result"].includes(value.type)) {
      this.available = true;
      if (value.type === "assistant" && record(value.message)) {
        const messageKey = String(value.message.id ?? index);
        if (!this.turns.has(messageKey)) { this.turns.add(messageKey); this.plannerTurns++; }
        if (Array.isArray(value.message.content)) for (const content of value.message.content) {
          if (record(content) && content.type === "tool_use") this.steps.add(String(content.id ?? `${messageKey}:${this.steps.size}`));
        }
      }
      this.lastEventAt = maxDefined(this.lastEventAt, timestamp(value.timestamp) ?? modified);
    }
  }

  finish(elapsedMs: number): RunMetrics {
    return {
      elapsedMs, plannerTurns: this.available ? this.plannerTurns : null,
      steps: this.available ? this.steps.size : null,
      graphsStarted: null, graphsCompleted: null, graphsFailed: null, avgGraphSize: null,
      jevCalls: null, synthCalls: null, jevAttempts: null, jevRetries: null,
      currentParallelism: null, peakParallelism: null, avgParallelism: null,
      repeatIterations: null, foreachItems: null, lastEventAt: this.lastEventAt ?? null,
      series: [], available: this.available,
    };
  }
}

function elapsed(run: RunRecord, now: number): number {
  if (typeof run.elapsedMs === "number" && Number.isFinite(run.elapsedMs)) return Math.max(0, run.elapsedMs);
  const start = timestamp(run.startedAt);
  if (start === undefined) return 0;
  const end = timestamp(run.finishedAt) ?? now;
  return Math.max(0, end - start);
}

async function metricPaths(run: RunRecord): Promise<{ sessions: string[]; events: string[]; attempts: string }> {
  const sessionDirs = await directories(join(run.workspace, ".jev/sessions"));
  const runDirs = await directories(join(run.workspace, ".jev/runs"));
  const sessions = [...new Set([
    ...(run.sessionArtifacts ?? []),
    ...sessionDirs.map(directory => join(directory, "session.jsonl")),
  ])];
  return {
    sessions,
    events: runDirs.map(directory => join(directory, "events.jsonl")),
    attempts: join(run.directory, "jev-attempts.jsonl"),
  };
}

/** Read only appended bytes on repeated dashboard polls and return a stable cross-agent shape. */
export async function getRunMetrics(run: RunRecord, now = Date.now()): Promise<RunMetrics> {
  const previous = pollTails.get(run.directory) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => getRunMetricsUnlocked(run, now));
  pollTails.set(run.directory, work.then(() => undefined, () => undefined));
  return work;
}

async function getRunMetricsUnlocked(run: RunRecord, now: number): Promise<RunMetrics> {
  let cache = caches.get(run.directory);
  if (!cache) {
    cache = { files: new Map(), reducer: new MetricReducer(), native: new NativeReducer() };
    caches.set(run.directory, cache);
  }
  const elapsedMs = elapsed(run, now);
  if (run.agent !== "jive") {
    const path = join(run.directory, "logs/agent.stdout.log");
    const state = await readIncremental(path, cache, (value, modified) => cache!.native.ingest(value, modified));
    if (state === "truncated") {
      caches.delete(run.directory);
      return getRunMetricsUnlocked(run, now);
    }
    return cache.native.finish(elapsedMs);
  }

  const paths = await metricPaths(run);
  for (const [path, source] of [
    ...paths.sessions.map(path => [path, "session"] as const),
    ...paths.events.map(path => [path, "raw"] as const),
    [paths.attempts, undefined] as const,
  ]) {
    const state = await readIncremental(path, cache, value => cache!.reducer.ingest(value, source));
    if (state === "truncated") {
      caches.delete(run.directory);
      return getRunMetricsUnlocked(run, now);
    }
  }
  const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]).has(run.status);
  const startedAt = timestamp(run.startedAt);
  const terminalAt = terminal
    ? timestamp(run.finishedAt) ?? (startedAt !== undefined && typeof run.elapsedMs === "number" ? startedAt + run.elapsedMs : now)
    : undefined;
  return cache.reducer.finish({
    now,
    elapsedMs,
    terminalAt,
    attemptTelemetryAvailable: await existing(paths.attempts),
  });
}
