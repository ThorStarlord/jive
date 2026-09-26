import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannerCases } from "../evals/planner/cases.ts";
import { hasSemanticContinuation, verifyOutputs } from "../evals/planner/verify.ts";
import { BATCH_EXAMPLE, DETERMINISTIC_BRANCH_EXAMPLE, SEMANTIC_BRANCH_EXAMPLE } from "../src/core/planner-examples.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))); });

test("semantic output checks require the chosen files and absence of unselected files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jive-eval-check-"));
  directories.push(cwd);
  const scenario = plannerCases.find(c => c.semantic)!;
  const routes = scenario.expected["routes.json"] as Record<string, string>;
  await writeFile(join(cwd, "routes.json"), JSON.stringify(routes));
  for (const item of JSON.parse(scenario.files["messages.json"]!)) {
    const directory = join(cwd, "work", routes[item.id]!);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${item.id}.txt`), item.text);
  }
  expect(Object.values(await verifyOutputs(scenario, cwd)).every(Boolean)).toBe(true);
  await writeFile(join(cwd, "work/technical/a.txt"), "should not be here");
  expect((await verifyOutputs(scenario, cwd))["technical/a"]).toBe(false);
  await rm(join(cwd, "work/billing/a.txt"));
  expect((await verifyOutputs(scenario, cwd))["billing/a"]).toBe(false);
});

test("behavior checks distinguish semantic continuations from judgments returned to the planner", () => {
  expect(hasSemanticContinuation(SEMANTIC_BRANCH_EXAMPLE)).toBe(true);
  expect(hasSemanticContinuation(BATCH_EXAMPLE)).toBe(true);
  expect(hasSemanticContinuation(DETERMINISTIC_BRANCH_EXAMPLE)).toBe(false);
  const decisionOnly = structuredClone(SEMANTIC_BRANCH_EXAMPLE);
  delete decisionOnly.nodes.billing;
  delete decisionOnly.nodes.technical;
  delete decisionOnly.nodes.review;
  expect(hasSemanticContinuation(decisionOnly)).toBe(false);
  const rootMerge = structuredClone(BATCH_EXAMPLE);
  // Exercise a root bash continuation independently of the streaming example's group wrapper.
  rootMerge.nodes.merge = {
    type: "bash", script: "cat", stdin: { $ref: "/groups/ratings/output/items" },
  };
  delete rootMerge.groups!.merge;
  delete rootMerge.templates!.rate!.nodes.save;
  rootMerge.templates!.rate!.output = { $ref: "/nodes/judge/output/answers" };
  expect(hasSemanticContinuation(rootMerge)).toBe(true);
  const synthContinuation = structuredClone(SEMANTIC_BRANCH_EXAMPLE) as any;
  synthContinuation.nodes.synth = {
    type: "synth",
    needs: ["route"],
    task: "Write a bounded response for the selected route.",
    input: { $ref: "/nodes/route/output/answers/team/choice" },
  };
  delete synthContinuation.nodes.billing;
  delete synthContinuation.nodes.technical;
  delete synthContinuation.nodes.review;
  expect(hasSemanticContinuation(synthContinuation)).toBe(true);
});
