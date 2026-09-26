import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGraph } from "../src/core/executor.ts";
import type { JevAdapter, SynthAdapter } from "../src/core/types.ts";
import { CRAWL_EXAMPLE, GRAPH_GUIDE, PLANNING_GUIDE, REFERENCE_EXAMPLE } from "../src/core/planner-guide.ts";
import { BATCH_EXAMPLE, DETERMINISTIC_BRANCH_EXAMPLE, PARALLEL_READS_EXAMPLE, SEMANTIC_BRANCH_EXAMPLE, SYNTH_VERIFICATION_EXAMPLE } from "../src/core/planner-examples.ts";
import { dependencies, validateGraph } from "../src/core/schema.ts";
import { PLANNER_SYSTEM_PROMPT } from "../src/planner/agent.ts";

describe("planner guide", () => {
  test("reference examples validate against the graph schema", () => {
    expect(() => validateGraph(structuredClone(REFERENCE_EXAMPLE))).not.toThrow();
    expect(() => validateGraph(structuredClone(CRAWL_EXAMPLE))).not.toThrow();
    for (const graph of [PARALLEL_READS_EXAMPLE, DETERMINISTIC_BRANCH_EXAMPLE, SEMANTIC_BRANCH_EXAMPLE, BATCH_EXAMPLE, SYNTH_VERIFICATION_EXAMPLE]) {
      expect(() => validateGraph(structuredClone(graph))).not.toThrow();
    }
  });

  test("the crawl example demonstrates a loop with per-item Jev decisions", () => {
    const crawl = CRAWL_EXAMPLE.groups.crawl;
    expect(crawl.kind).toBe("repeat");
    expect(CRAWL_EXAMPLE.templates.round.groups.expand.kind).toBe("foreach");
    expect(CRAWL_EXAMPLE.templates.expand.nodes.pick.type).toBe("jev");
    expect(CRAWL_EXAMPLE.returns).toEqual(["summary"]);
  });

  test("the planner prompt leads with policy and carries executable examples", () => {
    expect(PLANNER_SYSTEM_PROMPT.indexOf(PLANNING_GUIDE)).toBeLessThan(PLANNER_SYSTEM_PROMPT.indexOf(GRAPH_GUIDE));
    expect(GRAPH_GUIDE).toContain(JSON.stringify(REFERENCE_EXAMPLE));
    for (const graph of [PARALLEL_READS_EXAMPLE, DETERMINISTIC_BRANCH_EXAMPLE, SEMANTIC_BRANCH_EXAMPLE, BATCH_EXAMPLE, SYNTH_VERIFICATION_EXAMPLE]) {
      expect(GRAPH_GUIDE).toContain(JSON.stringify(graph));
    }
  });
});

describe("crawl example execution", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  async function workspace() {
    const cwd = await mkdtemp(join(tmpdir(), "jive-examples-"));
    directories.push(cwd);
    return cwd;
  }

  test("known independent reads have no dependencies and return both inputs", async () => {
    const cwd = await workspace();
    await Promise.all([writeFile(join(cwd, "README.md"), "task instructions"), writeFile(join(cwd, "package.json"), '{"name":"fixture"}')]);
    for (const node of Object.values(PARALLEL_READS_EXAMPLE.nodes)) expect(dependencies(node)).toEqual([]);
    const report = await executeGraph(PARALLEL_READS_EXAMPLE, { cwd, trackFileChanges: false });
    expect(report.status).toBe("done");
    expect((report.requested.instructions!.output as any).stdout).toBe("task instructions");
    expect((report.requested.manifest!.output as any).json).toEqual({ name: "fixture" });
  });

  test("deterministic branches handle both file states without calling Jev", async () => {
    const cwd = await workspace();
    const jev: JevAdapter = { evaluate: async () => { throw new Error("deterministic work must not call Jev"); } };
    await writeFile(join(cwd, "source.txt"), "source");
    const missing = await executeGraph(DETERMINISTIC_BRANCH_EXAMPLE, { cwd, jev, trackFileChanges: false });
    expect(missing.requested.cached!.status).toBe("skipped");
    expect((missing.requested.fallback!.output as any).stdout).toBe("source");
    await writeFile(join(cwd, "cached.txt"), "cache");
    const present = await executeGraph(DETERMINISTIC_BRANCH_EXAMPLE, { cwd, jev, trackFileChanges: false });
    expect((present.requested.cached!.output as any).stdout).toBe("cache");
    expect(present.requested.fallback!.status).toBe("skipped");
  });

  test("bounded synthesis receives explicit evidence and is verified deterministically", async () => {
    const cwd = await workspace();
    let calls = 0;
    const synth: SynthAdapter = {
      async generate(request) {
        calls++;
        expect(request.input).toEqual((SYNTH_VERIFICATION_EXAMPLE.context as any).target);
        return {
          model: "fixture/synth",
          text: '{"replacement":"return modernCall(input);"}',
          json: { replacement: "return modernCall(input);" },
        };
      },
    };
    const report = await executeGraph(SYNTH_VERIFICATION_EXAMPLE, { cwd, synth, trackFileChanges: false });
    expect(report.status).toBe("done");
    expect(calls).toBe(1);
    expect((report.requested.verify!.output as any).json).toEqual({ ok: true, reason: "verified" });
  });

  test("semantic decisions execute only the chosen continuation, including unknowns", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "ticket.txt"), "ticket evidence");
    for (const choice of ["billing", "technical", "review"]) {
      let calls = 0;
      const jev: JevAdapter = { evaluate: async request => {
        calls++;
        expect(request.state).toBe("ticket evidence");
        return { model: "fixture", answers: { team: { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(["billing", "technical", "review"].map(k => [k, Number(k === choice)])) } } };
      } };
      const report = await executeGraph(SEMANTIC_BRANCH_EXAMPLE, { cwd, jev, trackFileChanges: false });
      expect(report.status).toBe("done");
      expect(calls).toBe(1);
      expect(await readFile(join(cwd, "route.txt"), "utf8")).toBe(choice);
      expect(report.previews.filter(p => ["billing", "technical", "review"].includes(p.id) && p.status === "done").map(p => p.id)).toEqual([choice]);
    }
  });

  test("batch example persists successful evidence, merges outputs, and reports failed items", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "items.json"), JSON.stringify([{ id: "a", text: "one" }, { id: "b", text: "broken" }, { id: "c", text: "three" }]));
    const jev: JevAdapter = { evaluate: async request => {
      if (request.state === "broken") throw new Error("fixture failure");
      return { model: "fixture", answers: { clarity: { type: "score", score: 1.7, confidence: 0.8, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } } } };
    } };
    const report = await executeGraph(BATCH_EXAMPLE, { cwd, jev, trackFileChanges: false });
    expect(report.status).toBe("done");
    expect((report.requested.merge!.output as any).items[0].output).toEqual({ written: 2, failed: 1 });
    const rows = JSON.parse(await readFile(join(cwd, "ratings.json"), "utf8"));
    expect(rows.map((r: any) => [r.id, r.rating])).toEqual([["a", 2], ["c", 2]]);
    expect(JSON.parse(await readFile(join(cwd, "evidence/2.json"), "utf8"))).toEqual(rows[1]);
    const group = JSON.parse(await readFile(join(report.recordPath, "result-ratings.json"), "utf8"));
    expect(group.items).toBeUndefined();
    expect(group.output.items.map((i: any) => i.status)).toEqual(["done", "failed", "done"]);
  });

  test("the loop fetches each frontier in parallel, lets Jev pick per item, and stops when the frontier empties", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jive-crawl-"));
    directories.push(directory);
    // Local stand-in for the Wikipedia links API: title -> linked titles.
    await writeFile(join(directory, "links.json"), JSON.stringify({
      Rose: ["Flower", "Rosaceae"], Tulip: ["Flower", "Liliaceae"], Flower: ["Plant", "Rose"], Plant: ["Flower"],
    }));
    const graph = structuredClone(CRAWL_EXAMPLE) as any;
    graph.templates.expand.nodes.links.script =
      `python3 -c 'import json,sys; print("\\n".join(json.load(open("links.json")).get(sys.argv[1],[])))' "$TITLE"`;
    // Jev stand-in: take the first candidate, except on Plant where nothing qualifies.
    const jev: JevAdapter = { async evaluate(request) {
      const options = Object.keys((request.questions as any).next.criteria);
      const choice = (request.state as any).page === "Plant" ? "none" : options[0]!;
      return { model: "fixture", answers: { next: { type: "choice", choice, confidence: 0.9,
        probabilities: Object.fromEntries(options.map((id) => [id, id === choice ? 0.9 : 0.1 / (options.length - 1)])) } } };
    } };
    const report = await executeGraph(graph, { cwd: directory, jev });
    expect(report.status).toBe("done");
    const crawl = report.previews.find((p) => p.id === "crawl");
    expect(crawl?.status).toBe("done");
    const edges = await readFile(join(directory, "crawl", "edges.tsv"), "utf8");
    expect(edges.trim().split("\n").sort()).toEqual(["Flower\tPlant", "Rose\tFlower", "Tulip\tFlower"]);
    const visited = await readFile(join(directory, "crawl", "visited.txt"), "utf8");
    expect(visited.split("\n")).toEqual(["Flower", "Plant", "Rose", "Tulip"]);
    // Three rounds: seeds, then Flower, then Plant (whose "none" answer empties the frontier).
    const iterations = report.previews.filter((p) => /^crawl\[\d+\]\/merge$/.test(p.id));
    expect(iterations.map((p) => p.status)).toEqual(["done", "done", "done"]);
    expect((report.requested.summary?.output as any).stdout).toContain("3 crawl/edges.tsv");
  }, 20000);
});
