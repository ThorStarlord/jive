import type { Graph } from "./types.ts";

export const PARALLEL_READS_EXAMPLE: Graph = {
  version: 1, label: "Read independent task inputs",
  nodes: {
    instructions: { type: "bash", script: "cat README.md" },
    manifest: { type: "bash", script: "cat package.json", outputFormat: "json" },
  },
  returns: ["instructions", "manifest"],
};

export const DETERMINISTIC_BRANCH_EXAMPLE: Graph = {
  version: 1, label: "Use the available local input", limits: { maxJevCalls: 0 },
  nodes: {
    probe: { type: "bash", script: "test -f cached.txt", acceptedExitCodes: [0, 1] },
    cached: { type: "bash", when: { op: "eq", args: [{ $ref: "/nodes/probe/output/exitCode" }, 0] }, script: "cat cached.txt" },
    fallback: { type: "bash", when: { op: "eq", args: [{ $ref: "/nodes/probe/output/exitCode" }, 1] }, script: "cat source.txt" },
  },
  returns: ["cached", "fallback"],
};

export const SEMANTIC_BRANCH_EXAMPLE: Graph = {
  version: 1, label: "Route a support ticket",
  nodes: {
    read: { type: "bash", script: "cat ticket.txt" },
    route: {
      type: "jev", state: { $ref: "/nodes/read/output/stdout" },
      questions: { team: { type: "choice", instructions: "Which team should handle this ticket? Choose review when the text does not establish a team.", criteria: { billing: "Payments, charges, or invoices", technical: "Product errors or broken functionality", review: "Unclear or outside either team's scope" } } },
    },
    billing: { type: "bash", when: { op: "eq", args: [{ $ref: "/nodes/route/output/answers/team/choice" }, "billing"] }, script: "printf billing > route.txt" },
    technical: { type: "bash", when: { op: "eq", args: [{ $ref: "/nodes/route/output/answers/team/choice" }, "technical"] }, script: "printf technical > route.txt" },
    review: { type: "bash", when: { op: "eq", args: [{ $ref: "/nodes/route/output/answers/team/choice" }, "review"] }, script: "printf review > route.txt" },
  },
  returns: ["route"],
};

export const BATCH_EXAMPLE: Graph = {
  version: 1, label: "Rate clarity and save results", limits: { maxJevCalls: 100 },
  templates: { rate: {
    nodes: {
      judge: { type: "jev", state: { $ref: "/item/text" }, questions: {
        clarity: { type: "score", instructions: "How clearly is this message written?", criteria: ["Hard to understand", "Understandable with effort", "Clear and easy to follow"] },
      } },
      save: {
        type: "bash", env: { INDEX: { $ref: "/index" } },
        stdin: { id: { $ref: "/item/id" }, answer: { $ref: "/nodes/judge/output/answers/clarity" } },
        script: `python3 -c 'import json,sys,os; row=json.load(sys.stdin); row["rating"]=int(max(row["answer"]["probabilities"],key=row["answer"]["probabilities"].get)); os.makedirs("evidence",exist_ok=True); open("evidence/"+os.environ["INDEX"]+".json","w").write(json.dumps(row)); print(json.dumps(row))'`,
        outputFormat: "json",
      },
    },
    output: { $ref: "/nodes/save/output/json" },
  }, mergeResults: {
    nodes: {
      write: {
        type: "bash", stdin: { $ref: "/input" },
        script: `python3 -c 'import json,sys; items=json.load(sys.stdin); rows=[i["output"] for i in items if i["status"]=="done"]; open("ratings.json","w").write(json.dumps(rows)); print(json.dumps({"written":len(rows),"failed":len(items)-len(rows)}))'`,
        outputFormat: "json",
      },
    },
    output: { $ref: "/nodes/write/output/json" },
  } },
  nodes: { load: { type: "bash", script: "cat items.json", outputFormat: "json" } },
  groups: {
    ratings: { kind: "foreach", items: { $ref: "/nodes/load/output/json" }, template: "rate", maxItems: 100, concurrency: 6, onItemFailure: "continue" },
    merge: { kind: "foreach", items: [{ $ref: "/groups/ratings/output/items" }], template: "mergeResults", maxItems: 1 },
  },
  returns: ["merge"],
};


export const SYNTH_VERIFICATION_EXAMPLE: Graph = {
  version: 1,
  label: "Generate a bounded rewrite and verify it",
  limits: { maxSynthCalls: 1, maxJevCalls: 0 },
  context: {
    target: {
      path: "src/example.ts",
      source: "return legacyCall(input);",
      requirement: "Replace legacyCall with modernCall while preserving the function shape.",
    },
  },
  nodes: {
    draft: {
      type: "synth",
      task: "Return JSON with one field replacement containing only the rewritten source snippet.",
      input: { $ref: "/context/target" },
      outputFormat: "json",
      maxOutputTokens: 512,
    },
    verify: {
      type: "bash",
      stdin: { $ref: "/nodes/draft/output/json" },
      outputFormat: "json",
      script: `python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("replacement",""); ok="modernCall(" in s and "legacyCall(" not in s; print(json.dumps({"ok":ok,"reason":"verified" if ok else "rewrite did not satisfy the bounded contract"}))'`,
    },
  },
  returns: ["draft", "verify"],
};
