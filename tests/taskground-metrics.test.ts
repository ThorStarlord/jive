import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregate, getRunMetrics } from "../taskground/app/metrics.ts";
import type { RunRecord } from "../taskground/app/runner.ts";
import { JevClient } from "../src/jev/client.ts";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function event(sequence: number, time: number, type: string, nodeId?: string, data: Record<string, unknown> = {}) {
  return { sequence, time, graphId: "graph", type, ...(nodeId ? { nodeId } : {}), data };
}

test("aggregate deduplicates streamed session events and run-record fallbacks", () => {
  const started = event(1, 0, "graph.started");
  const nodeStarted = event(2, 10, "node.started", "work", { type: "bash" });
  const nodeFinished = event(3, 50, "node.finished", "work", {
    result: { type: "bash", status: "done", startedAt: 10, finishedAt: 50 },
  });
  const finished = event(4, 100, "graph.finished", undefined, { report: { status: "done" } });
  const records = [
    { id: "turn", type: "planner.request", timestamp: new Date(5).toISOString(), sequence: 1 },
    // This wrapper must not become a second graph.
    { id: "wrapper", type: "graph.stream.started", timestamp: new Date(0).toISOString(), data: { graphId: "graph" } },
    ...[started, nodeStarted, nodeFinished, finished].map(value => ({ type: "execution.event", data: { event: value } })),
    // events.jsonl contains the same events and is used only as a fallback.
    started, nodeStarted, nodeFinished, finished,
  ];
  const metrics = aggregate(records, { now: 100, elapsedMs: 100 });
  expect(metrics).toMatchObject({
    available: true, plannerTurns: 1, graphsStarted: 1, graphsCompleted: 1,
    graphsFailed: 0, steps: 1, avgGraphSize: 1, currentParallelism: 0, peakParallelism: 1,
  });
  expect(metrics.avgParallelism).toBe(.4);
});

test("leaf concurrency uses graph-wall union and closes cancelled and historical nodes", () => {
  const records = [
    event(1, 0, "graph.started"),
    event(2, 10, "node.started", "a", { type: "bash" }),
    event(3, 20, "node.started", "b", { type: "jev" }),
    event(4, 50, "node.finished", "a", { result: { type: "bash", status: "done", startedAt: 10, finishedAt: 50 } }),
    event(5, 70, "node.finished", "b", { result: { type: "jev", status: "done", startedAt: 20, finishedAt: 70 } }),
    event(6, 80, "node.started", "cancelled", { type: "bash" }),
    event(7, 90, "node.finished", "cancelled", { result: { type: "bash", status: "cancelled", startedAt: 80, finishedAt: 90 } }),
    event(8, 100, "graph.finished", undefined, { report: { status: "partial" } }),
  ];
  const metrics = aggregate(records, { now: 100 });
  expect(metrics.steps).toBe(3);
  expect(metrics.currentParallelism).toBe(0);
  expect(metrics.peakParallelism).toBe(2);
  expect(metrics.avgParallelism).toBe(1);
  expect(metrics.graphsFailed).toBe(1);
  expect(metrics.series.at(-1)?.active).toBe(0);

  const live = aggregate(records.slice(0, 2), { now: 100 });
  expect(live.currentParallelism).toBe(1);
  expect(live.avgParallelism).toBe(.9);
  expect(live.series.at(-1)?.active).toBe(1);
});

test("loop iterations count distinct parents rather than every body node", () => {
  const records: unknown[] = [event(1, 0, "graph.started")];
  let sequence = 2;
  const created = (id: string, type: string) => records.push(event(sequence++, sequence, "node.created", id, { type }));
  const started = (id: string, type = "bash") => records.push(event(sequence++, sequence, "node.started", id, { type }));
  created("each", "foreach"); created("again", "repeat");
  started("each[0]/read"); started("each[0]/write"); started("each[1]/read");
  started("again[0]/read"); started("again[0]/check"); started("again[1]/read");
  records.push(event(sequence++, 50, "graph.finished", undefined, { report: { status: "done" } }));
  const metrics = aggregate(records, { now: 50 });
  expect(metrics.foreachItems).toBe(2);
  expect(metrics.repeatIterations).toBe(2);
  expect(metrics.steps).toBe(6);
  expect(metrics.avgGraphSize).toBe(6);
});

function run(directory: string, agent: "jive" | "codex" | "claude"): RunRecord {
  return {
    schemaVersion: 1, id: "metric-run", task: "test", agent, mode: "headless", status: "running",
    createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), directory,
    workspace: join(directory, "workspace"), definition: join(directory, "definition"),
    source: { directory, revision: null, dirty: false, codeHash: "test" }, extraArgs: [],
    grading: { status: "ungraded" },
  };
}

test("getRunMetrics incrementally consumes appended Jive events and exposes old attempt counts as unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jive-metrics-")); scratch.push(directory);
  const session = join(directory, "workspace/.jev/sessions/one/session.jsonl");
  await mkdir(join(directory, "workspace/.jev/sessions/one"), { recursive: true });
  await mkdir(join(directory, "logs"), { recursive: true });
  const wrap = (value: unknown) => JSON.stringify({ type: "execution.event", data: { event: value } }) + "\n";
  await writeFile(session, wrap(event(1, 10, "graph.started")) + wrap(event(2, 20, "node.started", "live", { type: "bash" })) +
    wrap(event(3, 25, "node.output", "live", { stream: "stdout", chunk: "still working" })));
  const first = await getRunMetrics(run(directory, "jive"), 30);
  expect(first).toMatchObject({ steps: 1, currentParallelism: 1, lastEventAt: 25, jevAttempts: null, jevRetries: null });
  await appendFile(session, wrap(event(4, 40, "node.finished", "live", { result: { type: "bash", status: "done", startedAt: 20, finishedAt: 40 } })));
  const second = await getRunMetrics(run(directory, "jive"), 50);
  expect(second).toMatchObject({ steps: 1, currentParallelism: 0 });
});

test("session graph events replace raw fallback despite remapped, colliding sequences and live discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-metrics-")); scratch.push(directory);
  const raw = join(directory, "workspace/.jev/runs/graph/events.jsonl");
  await mkdir(join(directory, "workspace/.jev/runs/graph"), { recursive: true });
  await mkdir(join(directory, "logs"), { recursive: true });
  const rawEvents = [
    event(1, 10, "graph.started"),
    event(2, 20, "node.started", "judge", { type: "jev" }),
    event(3, 30, "jev.request", "judge"),
    event(4, 40, "node.finished", "judge", { result: { type: "jev", status: "done", startedAt: 20, finishedAt: 40 } }),
    event(5, 50, "graph.finished", undefined, { report: { status: "done" } }),
  ];
  await writeFile(raw, rawEvents.map(value => JSON.stringify(value)).join("\n") + "\n");
  const taskRun = run(directory, "jive");
  expect(await getRunMetrics(taskRun, 60)).toMatchObject({ steps: 1, jevCalls: 1, graphsCompleted: 1 });

  const session = join(directory, "workspace/.jev/sessions/new/session.jsonl");
  await mkdir(join(directory, "workspace/.jev/sessions/new"), { recursive: true });
  const sessionEvents = [
    event(1, 5, "graph.building"), event(2, 7, "graph.preview"),
    // Sequence 3 is graph.started here but jev.request in the raw executor log.
    event(3, 10, "graph.started"),
    event(4, 20, "node.started", "judge", { type: "jev" }),
    event(5, 25, "node.output", "judge", { stream: "stdout", chunk: "progress" }),
    event(6, 30, "jev.request", "judge"),
    event(7, 40, "node.finished", "judge", { result: { type: "jev", status: "done", startedAt: 20, finishedAt: 40 } }),
    event(8, 50, "graph.finished", undefined, { report: { status: "done" } }),
  ];
  const wrap = (value: unknown) => JSON.stringify({ type: "execution.event", timestamp: new Date((value as any).time).toISOString(), data: { event: value } });
  await writeFile(session, sessionEvents.map(wrap).join("\n") + "\n");
  for (let poll = 0; poll < 3; poll++) {
    expect(await getRunMetrics(taskRun, 60 + poll)).toMatchObject({
      steps: 1, jevCalls: 1, graphsStarted: 1, graphsCompleted: 1, lastEventAt: 50,
    });
  }
});

test("terminal runs implicitly close unfinished graphs and freeze concurrency at finishedAt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-metrics-")); scratch.push(directory);
  const session = join(directory, "workspace/.jev/sessions/one/session.jsonl");
  await mkdir(join(directory, "workspace/.jev/sessions/one"), { recursive: true });
  await mkdir(join(directory, "logs"), { recursive: true });
  const wrap = (value: unknown) => JSON.stringify({ type: "execution.event", data: { event: value } }) + "\n";
  await writeFile(session, wrap(event(1, 1_000, "graph.started")) + wrap(event(2, 1_100, "node.started", "stuck", { type: "bash" })));
  const taskRun = {
    ...run(directory, "jive"), status: "cancelled" as const,
    startedAt: new Date(1_000).toISOString(), finishedAt: new Date(2_000).toISOString(), elapsedMs: 1_000,
  };
  const first = await getRunMetrics(taskRun, 5_000), later = await getRunMetrics(taskRun, 50_000);
  for (const metrics of [first, later]) {
    expect(metrics.currentParallelism).toBe(0);
    expect(metrics.avgParallelism).toBe(.9);
    expect(metrics.graphsFailed).toBe(1);
    expect(metrics.series.at(-1)).toMatchObject({ time: 2_000, active: 0, steps: 1 });
  }
  expect(later.series).toEqual(first.series);
});

test("concurrent polls serialize incremental reads and ingest Jev attempt lines once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poll-metrics-")); scratch.push(directory);
  const session = join(directory, "workspace/.jev/sessions/one/session.jsonl");
  await mkdir(join(directory, "workspace/.jev/sessions/one"), { recursive: true });
  await mkdir(join(directory, "logs"), { recursive: true });
  await writeFile(session, JSON.stringify({ id: "request", sequence: 1, timestamp: new Date(10).toISOString(), type: "planner.request", data: {} }) + "\n");
  await writeFile(join(directory, "jev-attempts.jsonl"), [
    { time: 11, type: "attempt" }, { time: 12, type: "retry" }, { time: 13, type: "attempt" },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const taskRun = run(directory, "jive");
  const results = await Promise.all(Array.from({ length: 20 }, () => getRunMetrics(taskRun, 20)));
  expect(results.every(metrics => metrics.jevAttempts === 2 && metrics.jevRetries === 1)).toBe(true);
  expect((await getRunMetrics(taskRun, 21)).jevAttempts).toBe(2);
});

test("agents without parseable native headless logs report unsupported metrics as null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-metrics-")); scratch.push(directory);
  await mkdir(join(directory, "logs"), { recursive: true });
  await mkdir(join(directory, "workspace"), { recursive: true });
  await writeFile(join(directory, "logs/agent.stdout.log"), "interactive output, not JSON\n");
  const metrics = await getRunMetrics(run(directory, "codex"), 25);
  expect(metrics.available).toBe(false);
  expect(metrics.steps).toBeNull();
  expect(metrics.plannerTurns).toBeNull();
  expect(metrics.graphsStarted).toBeNull();
  expect(metrics.series).toEqual([]);
});

test("native Codex and Claude JSON logs expose only the counters their formats support", async () => {
  const codexDirectory = await mkdtemp(join(tmpdir(), "codex-metrics-")); scratch.push(codexDirectory);
  await mkdir(join(codexDirectory, "logs"), { recursive: true });
  await mkdir(join(codexDirectory, "workspace"), { recursive: true });
  await writeFile(join(codexDirectory, "logs/agent.stdout.log"), [
    { type: "thread.started", thread_id: "thread" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "command", type: "command_execution" } },
    { type: "item.completed", item: { id: "command", type: "command_execution" } },
  ].map(value => JSON.stringify(value)).join("\n"));
  const codex = await getRunMetrics(run(codexDirectory, "codex"), 25);
  expect(codex).toMatchObject({ available: true, plannerTurns: 1, steps: 1, graphsStarted: null, avgParallelism: null });

  const claudeDirectory = await mkdtemp(join(tmpdir(), "claude-metrics-")); scratch.push(claudeDirectory);
  await mkdir(join(claudeDirectory, "logs"), { recursive: true });
  await mkdir(join(claudeDirectory, "workspace"), { recursive: true });
  await writeFile(join(claudeDirectory, "logs/agent.stdout.log"), JSON.stringify({
    type: "assistant", message: { id: "message", content: [
      { type: "tool_use", id: "read", name: "Read" }, { type: "tool_use", id: "bash", name: "Bash" },
    ] },
  }) + "\n");
  const claude = await getRunMetrics(run(claudeDirectory, "claude"), 25);
  expect(claude).toMatchObject({ available: true, plannerTurns: 1, steps: 2, jevCalls: null, currentParallelism: null });
});

test("Jev HTTP attempt telemetry is minimal, retry-aware, and cannot expose request data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-attempts-")); scratch.push(directory);
  const path = join(directory, "attempts.jsonl"), previous = process.env.JEV_METRICS_FILE;
  process.env.JEV_METRICS_FILE = path;
  let calls = 0;
  const fetchMock = async () => ++calls === 1
    ? new Response("upstream secret body", { status: 503 })
    : Response.json({ model: "test", answers: { choice: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } } } });
  try {
    const client = new JevClient({ apiKey: "secret-token", fetch: fetchMock as unknown as typeof fetch, retries: 1 });
    await client.evaluate({ state: { private: "never-log" }, questions: { choice: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } } } });
  } finally {
    if (previous === undefined) delete process.env.JEV_METRICS_FILE;
    else process.env.JEV_METRICS_FILE = previous;
  }
  const text = await readFile(path, "utf8"), rows = text.trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.type)).toEqual(["attempt", "retry", "attempt"]);
  expect(rows.every(row => Object.keys(row).sort().join(",") === "time,type")).toBe(true);
  expect(text).not.toContain("secret");
  expect(aggregate(rows).jevAttempts).toBe(2);
  expect(aggregate(rows).jevRetries).toBe(1);
});


test("synthesis calls are tracked separately from semantic judgments", () => {
  const records = [
    event(1, 0, "graph.started"),
    event(2, 10, "node.started", "write", { type: "synth" }),
    event(3, 15, "synth.request", "write", { model: "fixture/synth" }),
    event(4, 30, "synth.response", "write", { model: "fixture/synth", usage: { promptTokens: 21, completionTokens: 8 } }),
    event(5, 40, "node.finished", "write", { result: { type: "synth", status: "done", startedAt: 10, finishedAt: 40 } }),
    event(6, 50, "graph.finished", undefined, { report: { status: "done" } }),
  ];
  const metrics = aggregate(records, { now: 50 });
  expect(metrics).toMatchObject({
    steps: 1, synthCalls: 1, synthPromptTokens: 21, synthCompletionTokens: 8,
    jevCalls: 0, peakParallelism: 1,
  });
  expect(metrics.series.at(-1)).toMatchObject({ synthCalls: 1, jevCalls: 0 });
});
