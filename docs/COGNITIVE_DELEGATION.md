# Cognitive Delegation

Status: v1 construction contract for the Jive fork.

## Governing idea

Jive should spend generative reasoning according to **novelty**, not according to
repository size or execution volume.

Different kinds of work belong to different mechanisms:

| Work | Mechanism | Typical examples |
| --- | --- | --- |
| Novel reasoning | planner / frontier model | strategy, architecture, unexpected diagnosis, new rubric |
| Deterministic reconnaissance | `bash`, extractors, parsers | AST queries, search, counting, tests, indexing |
| Bounded semantic judgment | `jev` | relevance, classification, ranking, sufficiency |
| Bounded generation | `synth` | a known patch, test, rewrite, migration fragment |
| Execution and verification | `bash` / host runtime | apply, format, compile, test, inspect |

This is a cognitive-responsibility split, not a model-size hierarchy. A cheap
generative model is still generative; a Jev judgment is not deterministic; and a
Bash/AST operation should not become an LLM call merely because one is available.

## The `synth` contract

A `synth` node is deliberately **not another agent**.

It receives only:

- a bounded `task`;
- explicit `input` evidence resolved from the current graph;
- an optional model and reasoning effort;
- an output format (`text` or `json`);
- an output-token ceiling.

It receives **no tools**, cannot inspect the repository, and cannot acquire more
context. Missing evidence must cause failure or escalation rather than autonomous
reconnaissance.

Example:

```json
{
  "type": "synth",
  "task": "Rewrite only the supplied function to use Drizzle.",
  "input": {"$ref": "/nodes/extract/output/json"},
  "outputFormat": "json",
  "maxOutputTokens": 2048
}
```

The graph-wide `maxSynthCalls` limit bounds generation volume. `foreach` may
fan out independent synthesis jobs, but overlapping write ownership should be
partitioned before generation. Applying generated edits remains a separate
execution step.

## Recon -> judge -> synth -> verify -> escalate

The preferred lifecycle is:

```text
frontier planner
   |
   | defines evidence need and bounded phase
   v
deterministic recon
   |
   +--> Jev judgment when semantic routing is needed
   |
   v
bounded synth on selected targets
   |
   v
deterministic apply / format / compile / tests
   |
   +-- pass ------------------------------> continue
   |
   +-- bounded known failure --> Jev --> repair/retry when already specified
   |
   +-- novel or architectural failure ----> planner
```

Known continuations should stay inside the graph. The planner should re-enter when
the continuation itself requires new reasoning, not merely because another file or
test exists.

## Cognitive-allocation evidence

Taskground distinguishes:

- planner turns;
- executed leaf steps;
- Jev calls and retry attempts;
- Synth calls;
- graph size and outcomes;
- concurrency;
- foreach items and repeat iterations.

The architectural hypothesis is stronger than "fewer LLM calls":

> Repository-scale work should increase without frontier reasoning increasing
> proportionally.

Useful future qualification metrics include frontier input/output tokens, targets
processed deterministically, average Synth context size, Synth retry rate,
verification pass rate, and frontier escalations per completed transformation.

## Authority and evidence boundaries

Graph execution remains effectful. v1 adds enforceable seams:

- ambient credential-like environment variables are removed from child Bash
  processes;
- declarative Bash and extractor `cwd` values cannot select a directory outside
  the session workspace;
- an embedding host may provide `ExecuteOptions.authorize` and reject any Bash,
  Jev, or Synth leaf before its side effects or remote request begin;
- Synth receives no tools or implicit repository access;
- all Synth requests/responses record model/provider/usage provenance in graph
  events and artifacts.

These are **guards, not a sandbox**. Bash itself can navigate the host filesystem
or network unless the embedding environment applies stronger isolation. Extractor
modules still execute in the Jive process and therefore remain a stronger trust
boundary than child commands.

## Escalation rules

Escalate to the planner when:

- a new strategy or architectural choice is required;
- supplied evidence is insufficient and the missing evidence was not already
  described by the graph;
- a failure class was not anticipated by the bounded phase;
- the generator would need independent repository exploration;
- a user/owner choice is required.

Do not escalate merely because:

- there are many items;
- a deterministic loop has another iteration;
- a known classification is needed;
- independent targets can be synthesized from already supplied evidence;
- a verification branch has a known bounded recovery.

## Non-goals

Cognitive Delegation v1 does not introduce:

- generic sub-agents;
- an arbitrary `llm` node;
- a workflow planner separate from the frontier planner;
- automatic model routing by numeric score;
- automatic authority decisions;
- a claim that child Bash or extractor plugins are sandboxed.

The point is to preserve Jive's graph-first architecture while completing the
missing bounded-generative layer.
