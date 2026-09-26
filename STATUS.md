# Status

Last reconciled: 2026-09-26

## Product state

Jive is a graph-driven terminal agent with a mature executable graph runtime,
streaming graph construction, durable sessions, Jev semantic decisions, a TUI,
and Taskground comparison infrastructure.

The current fork is advancing **Cognitive Delegation v1**:

```text
novel reasoning          -> planner
deterministic scale      -> bash / extractors
bounded semantic choice  -> jev
bounded generation       -> synth
verification             -> deterministic runtime
novel exception          -> planner
```

The governing efficiency hypothesis is:

> Frontier reasoning should scale with decision novelty rather than execution
> volume.

## Current construction frontier

Branch: `work/cognitive-delegation-v1`

Implemented on the branch:

- restored the missing `evals/planner/*` sources referenced by scripts, tests,
  and documentation;
- added a first-class `synth` graph node for tool-less bounded generation;
- added graph-wide `maxSynthCalls` and per-node output/input bounds;
- made the OpenRouter client support tool-less bounded completions;
- added Synth request/response provenance and graph-UI support;
- added Taskground Synth-call telemetry alongside planner/Jev/runtime metrics;
- confirmed `foreach` can fan out bounded Synth work under graph concurrency;
- added child-command credential filtering;
- added declarative workspace-`cwd` path guards;
- added an optional host authorization hook before Bash/Jev/Synth leaf execution.

## Qualification state

Repository qualification is **pending** for the branch until the canonical CI
surface completes:

```sh
bun run typecheck
bun test
```

Do not treat Cognitive Delegation v1 as merged, released, or fully qualified
until that evidence exists.

The restored planner live evaluation and Taskground model comparisons remain
opt-in/live qualification rather than ordinary CI.

## Current claim ceiling

Implemented guards do **not** make Jive a sandbox.

- Bash can still navigate the host filesystem or use the network unless the host
  provides stronger isolation.
- Extractor modules execute in the Jive process and are not isolated.
- The default authorization hook is permissive unless an embedding host supplies
  policy.
- Synth is bounded by construction: it has no tools and only receives explicit
  graph evidence.

## Evidence language

Keep these distinct:

```text
demo result
!= reproducible Taskground result
!= repository qualification
!= broad product-quality claim
```

Taskground development adaptations are useful comparative evidence, not proof
that Jive is generally higher quality across software-engineering work.

## Next construction responsibilities

1. Make the Cognitive Delegation branch typecheck/test green.
2. Reconcile any third-node assumptions found by qualification.
3. Add a retained verification/escalation example and targeted qualification.
4. Strengthen host authority/sandbox integration without pretending local path
   guards are process isolation.
5. Qualify the central cognitive-allocation hypothesis on representative tasks.
