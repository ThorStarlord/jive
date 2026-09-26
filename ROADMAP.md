# Roadmap

## Governing goal

Build Jive into a trustworthy graph-driven cognitive delegation runtime where
frontier reasoning is reserved for genuine novelty, bounded lower-cost mechanisms
handle scalable judgment/generation, and execution remains observable and
governable.

The roadmap prioritizes retained capability. Benchmarks and experiments support
construction; they are not the construction goal by themselves.

## Phase 0 — Canonical integrity

**Goal:** ordinary repository checks represent a coherent source tree.

- Restore/remove stale source references.
- Keep portable and strict graph schemas synchronized.
- Keep documentation, examples, and tests aligned with the executable contract.
- Require typecheck + offline test evidence before claiming a construction
  package qualified.

Current state: restored planner-eval sources on the Cognitive Delegation branch;
branch qualification pending.

## Phase 1 — Cognitive Delegation v1

**Goal:** complete Jive's missing bounded-generative layer without introducing
generic sub-agents.

- `bash`: deterministic/environmental computation.
- `jev`: bounded semantic judgment.
- `synth`: bounded tool-less generation from explicit evidence.
- planner: novel strategy, architecture, new diagnosis/rubric, owner decisions.
- `foreach` + `synth`: independent bounded transformations.
- deterministic verification after generated work.
- planner re-entry only for genuinely novel continuation.

Current state: implementation in progress on
`work/cognitive-delegation-v1`.

## Phase 2 — Cognitive-allocation observability

**Goal:** measure where cognition actually occurs.

Retain at minimum:

- planner turns;
- frontier prompt/completion tokens where available;
- deterministic leaf steps;
- Jev calls/retries;
- Synth calls;
- Synth context/output usage;
- graph size/concurrency;
- foreach/repeat work;
- verification outcome;
- planner escalations after bounded work.

The important system-level signal is whether useful transformation volume can
grow without planner/frontier work growing proportionally.

## Phase 3 — Verification and selective escalation

**Goal:** make known recovery stay below the frontier planner.

Preferred control shape:

```text
recon -> route -> synth -> apply -> verify
                            |
                    known bounded failure
                            v
                       route/repair
                            |
                       novel failure
                            v
                         planner
```

Add representative examples and Taskground cases for repository-scale
transformations with explicit ownership boundaries and deterministic verification.

## Phase 4 — Execution governance

**Goal:** make high delegation safer without conflating autonomy with authority.

Construction priorities:

- pre-effect authorization surface;
- ambient-secret minimization;
- workspace/path integrity;
- network/process capability policy;
- isolated execution option for Bash;
- extractor/plugin isolation;
- clear destructive/external-effect policy;
- evidence-preserving denials/yields.

The first three seams are being introduced in Cognitive Delegation v1. Strong
process/network/plugin isolation remains future work.

## Phase 5 — Evidence contract

**Goal:** ensure public/product claims match retained evidence.

Every consequential comparison should identify:

- exact source revision;
- task/verifier version;
- model and effort;
- execution environment;
- repetitions/variance where material;
- correctness gate;
- what the result establishes and does not establish.

Do not generalize development-adaptation benchmark wins into broad quality
claims without representative qualification.

## Phase 6 — Portability and execution backends

**Goal:** separate the Graph IR from a Bash-only local host.

Candidate retained backends:

- local Bash;
- PowerShell/Windows;
- isolated container;
- remote worker.

Execution backends must preserve graph identity, artifact provenance,
cancellation, authority checks, and result semantics.

## Phase 7 — Broader graph execution

Only after the cognitive and authority boundaries are stable, consider:

- structured enterprise/API tools;
- browser execution;
- remote/distributed leaf workers;
- durable resumable long-running graphs.

Do not add generic agents merely because another model can be called. New
execution surfaces should preserve the reasoning/judgment/synthesis/execution
separation.
