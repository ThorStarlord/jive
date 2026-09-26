# Graph contract

Status: implemented runtime contract. The executable schema and scheduler are in
src/core/. Confirmed requirements live in [DESIGN.md](../DESIGN.md); `--schema`
and examples define the precise implemented JSON surface.

## Shape

One `execute_graph` invocation describes a versioned graph with a label, context,
executable nodes, reusable templates, structural expansion/repetition blocks,
limits, and a declaration of full results requested by the planner.

`bash`, `jev`, and `synth` are the executable node types. Per-item expansion and
repetition are structural groups containing those nodes. They can be displayed
as expandable groups in the UI without becoming extra LLM-facing tools.

A graph containing one bash node is valid. The planner can perform an immediate
observation or write a prepared patch without constructing an unnecessary Jev
decision.

Each fully closed, validated root entry commits automatically while tool arguments
stream. Write version, label, and any context, templates, limits or output before
nodes/groups; omitted settings use defaults. Committed definitions are immutable.
An entry commits once every root entry it depends on has committed; one written
before its dependencies waits for them, and one whose dependency never arrives
fails the final whole-graph validation. Requested returns may come last. There is
no eager option. Saved graph replay, non-streaming hosts, and tool arguments that
arrive in a single fragment validate the entire graph and permit forward
references and any key order. Unset optional fields sent as null are dropped. See
the streaming example and recovery behavior in [the overview](README.md).

## Saved graph replay

`execute_graph_mod` accepts exactly one of `base` (a saved graphId) or `file`
(an absolute graph JSON path or one relative to the session cwd). `edits` is
optional; omission or `[]` executes unchanged. Edits and an optional label apply
to a copy, then the same executor validates, runs, and records a fresh graphId.
The source graph stays unchanged. All nodes run again; there is no implicit
resumption or cache. Node paths are relative to the session cwd regardless of
the source file location. Standalone replay uses `jive --cwd DIR --run FILE --json`.

Reports contain `graphId`, `status`, `recordPath`, `previews`, and `requested`.
Requested results and saved `result-ID.json` artifacts are envelopes with
`id`, `type`, `status`, `output`, `error`, and `artifact` as applicable. A saved
foreach result's items are at `output.items`, never at the envelope root. Inside
the graph use `/groups/ID/output/items` to pass them to an aggregation node.

## References

Use explicit objects such as:

```json
{"$ref": "/nodes/search/output/stdout"}
```

The pointer namespace is scoped to the current graph or template
instance. References preserve JSON value types. A literal string containing a
pointer is ordinary text, not an interpolated expression. Literal data that
matches a reserved expression shape needs an explicit literal wrapper.

Each scope exposes named context, inputs, completed node outputs, and completed
structural-group results. Template children receive declared inputs rather than
implicitly seeing every other expansion item. Use a bash node to read saved
artifacts from earlier graphs; pointers resolve within the current execution.

Derive data dependencies from references and allow explicit ordering
dependencies where no value is passed. Reject illegal cycles outside bounded
repetition and missing dependency targets before any operations run. Resolve
pointer paths and check dynamic item types during execution; missing values
produce explicit errors.

## Bash

Fields: script, working directory, environment/data bindings, stdin,
timeout, accepted exit codes, ordering dependencies, and activation condition.

Run each node in its own shell process. Filesystem changes persist; shell-local
variables and directory changes do not implicitly become another node's state.
Use explicit bindings for that state transfer.

Store stdout and stderr completely in artifacts, along with the exit status and
whether execution timed out or was interrupted. How much enters a model's
context is a separate decision. An accepted nonzero exit can carry evidence to
downstream nodes; an unhandled failure invokes the graph's failure policy.

## Jev and plugins

A Jev node selects input references, optionally runs a declared extractor
pipeline, constructs state and questions, invokes Jev, and evaluates acceptance
criteria. The actual state and question definitions sent to Jev are recorded.
`accept` is optional: omission accepts any schema-valid answer. A supplied
condition that evaluates false yields to the planner. Choice answers expose
`choice`, `confidence`, and `probabilities`; score answers expose a possibly
fractional `score`, `confidence`, and probabilities keyed by zero-based string
indices; `noul` answers expose the yes-probability `noul` without confidence.

Plugins can perform commands and network operations. They receive explicit
inputs, configuration, cancellation, and runtime helpers for observable work.
Each output has a schema. Preparation errors are distinct from Jev transport
errors and from decisions that fail acceptance criteria.

For candidate selection, retain both the choice descriptions shown to Jev and a
mapping from choice IDs to original records. Resolve accepted choices through
that mapping before exposing selected values to subsequent nodes.

Choice, score, and probability questions have different result meanings.
Acceptance conditions operate on the relevant fields. Do not infer a universal
threshold or interpret a derived confidence statistic as measured correctness.

Independent questions using the same state may share one Jev request. Questions
that need a preceding answer require a subsequent execution with that answer in
their state.

## Bounded synthesis

A `synth` node performs tool-less bounded generation. It receives a generation
`task` and explicit `input` evidence resolved from the current graph. It may
choose a model/effort, `text` or `json` output, and an output-token ceiling.

Synth has no tool schema and no independent repository access. It cannot search
for missing context, run commands, or browse. A caller that needs additional
evidence must obtain it in earlier graph nodes or return to the planner. Every
request/response records the resolved input, requested/resolved model, provider,
usage, and output in execution events/artifacts.

`foreach` can instantiate independent Synth work concurrently under the same
global leaf semaphore. Generated text does not mutate the workspace by itself;
applying a patch or writing a file remains an explicit Bash/runtime operation.
This keeps generation separate from execution authority.

See [COGNITIVE_DELEGATION.md](COGNITIVE_DELEGATION.md) for the reasoning,
judgment, synthesis, verification, and escalation responsibilities.

## Conditions and branches

Use a small declarative predicate vocabulary: comparisons, membership,
existence, and boolean combinations. Conditions resolve typed references; they
do not execute arbitrary JavaScript.

An activation condition is evaluated once its input dependencies have settled.
False means skipped; an upstream required failure means blocked. Missing data
must not silently evaluate to false. A required downstream reference to a
skipped result needs an explicit alternative or merge.

Default joins wait for all required inputs. A recovery/merge node may set
`allowFailedDependencies: true` and inspect the explicit status of every input.
There is no implicit selection of whichever branch happened to succeed.

## Parallel expansion

A per-item group declares an input collection, template, input mapping, maximum
item count, and concurrency limit. Expansion creates unique execution instances
from the supplied template; plugins do not emit arbitrary new structure.

Results retain stable input order and item identities, regardless of completion
order. Each item has a result envelope, including failures. Collection consumers
must be able to inspect partial success rather than silently losing failed items.

Nested expansion shares the graph's concurrency, timeout, Jev-call, and Synth-call limits. If an
input collection exceeds its declared limit, report that explicitly rather than
quietly ignoring remaining items. An empty collection produces an empty result
and no child executions.

## Bounded repetition

A repetition group declares initial state, a body template, next-state bindings,
an exit condition, and a maximum iteration count. The exit condition's timing
is explicit: `until` evaluates after each completed
body iteration.

Each iteration gets immutable inputs. Its next-state bindings define the next
iteration's inputs. Records retain all iterations, even when the final group
result projects only selected outputs. Reaching the iteration limit without
satisfying the exit condition produces an explicit exhausted outcome, not an
implied success.

## Failure, uncertainty, and interruption

An unhandled node failure blocks dependent work. Independent branches may finish;
the graph can instead declare global-stop behaviour. Explicit recovery branches
can consume failure records.

A decision that fails acceptance criteria follows a supplied recovery branch or
requests handoff to the planner. The default is to finish
independent eligible work and aggregate handoffs into one graph result, consistent
with the failure policy. Dependent nodes are blocked unless they explicitly
accept failed dependencies; independent eligible nodes continue normally.

User interruption and a declared global stop prevent new work from starting and
propagate cancellation to active operations. Already completed effects remain
completed. Replaying the event log never reruns commands or plugin operations.

## Limits

Configure concurrent executions, elapsed time, Jev request count, Synth request
count, and local loop/expansion limits. Runtime ceilings apply even
when a submitted graph requests larger values. A reached limit produces a
recorded stopping reason and preserves partial results.

Long parallel workloads are first-class. The interface reports completed,
running, waiting, blocked, and skipped work; an expanding graph does not have a
fixed total suitable for a guessed completion percentage.

## Results, events, and context

Every invocation returns a graph outcome, compact previews for every execution,
and full results for requested nodes/groups. Store complete artifacts separately
from model-visible projections. Append the completed result once to planner
history. Deterministic compaction retains approximately the recent 30% and a
searchable session archive; oversized individual outputs still need a policy.

Jev state is assembled explicitly per decision from selected references and
extractor outputs. It has its own budget and does not automatically receive the
planner history. See [CONTEXT.md](CONTEXT.md) for the researched limits and
proposed assembly contract.

Emit events for graph validation/start, expansion, iteration, node readiness and
start, output chunks, plugin activity through runtime helpers, Jev decisions,
Synth requests/responses, dependency satisfaction, terminal node states, and final
graph outcomes.

Events drive both the terminal UI and headless observation. Assign stable IDs and
sequence numbers so a UI can reconstruct execution state from recorded events.
Green advancing along an edge represents its dependency becoming available;
it does not imply every other input of its destination is ready.
