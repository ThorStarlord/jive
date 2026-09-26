# Planner behavior evaluation

Run `bun run eval:planner --model MODEL`. This opt-in suite makes real planner and
Jev API calls using configured credentials; ordinary `bun test` stays offline.
Use `--case NAME` to run one case, `--timeout SECONDS` to bound each case, and
`--out report.json` to choose the report path. Temporary task workspaces and their
session logs are retained for inspection. Repeat runs across models and revisions
before drawing conclusions from changes in scores or timing.

The prompts and input files in `cases.ts` describe tasks without graph or Jev
instructions. Expected answers stay outside the task workspace. Cases cover
independent reads, both deterministic branches, semantic batch routing with
conditional file output, and saved-file execution. Output correctness, absence
of capability probes, appropriate use of model judgments with a downstream
continuation in the same graph, and native file replay are checked.

Reports include planner requests, graph calls, Jev calls, first judgment round,
independent root entries, foreach groups, conditional nodes, rejected tool calls,
graphs with semantic continuations, elapsed time and prompt tokens. Parallel width
and branch counts describe the plan; they do not prove efficiency by themselves.
