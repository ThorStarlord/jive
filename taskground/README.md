# taskground

Reusable task definitions and retained, fresh workspaces for Jive, Codex, and Claude
Code. Launches are local processes. Interactive agents open in the current terminal.

```sh
bun run taskground list
bun run taskground run intent_routing --agent jive
bun run taskground run product_matching --agent codex
bun run taskground run sembench_movie --agent claude
bun run taskground run slow_trace_search --agent jive
bun run taskground run search_results_race --agent jive
bun run taskground run search_latency --agent jive
bun run taskground run async_blocking_audit --agent jive
bun run taskground run error_handling_audit --agent jive
bun run taskground run retry_audit --agent jive
bun run taskground run cognitive_bulk_migration --agent jive
```

Run `npm install --no-package-lock` first if dependencies are absent. If Bun is not
on PATH, use `node_modules/.bin/bun run taskground ...`. Python 3 and Git are required;
Codex/Claude must be installed and authenticated for those profiles. Jive runs the
selected source snapshot's `bin/jive`, so each run retains the code it started with.

## Browser dashboard

```sh
bun run taskground launch
# Print the local URL without opening a browser, or choose a different port:
bun run taskground launch --no-open --port 4317
```

The local dashboard shows native agent terminals, headless runs and searchable
history, live metrics, source provenance, cancellation, verification and recording
export. New dashboard runs default to **Native terminal**; **Headless logs** remains
available. Ordinary `run ... --headless` CLI runs appear automatically, including
runs started while the dashboard was closed. Local interactive CLI runs are excluded.
Closing the dashboard does not stop its detached agents; reopening reconnects to
their saved records. No background daemon is required. A foreground CLI run still
belongs to its launching terminal; use `--detach` to let that run outlive it.

The **Terminal** tab renders the agent's actual native UI, including cursor movement,
colors and full-screen updates. A Bun PTY is owned by the detached run supervisor;
tmux is not required. Open **Attach** to type into that same process, answer permission
prompts, or submit follow-up messages. **Detach** returns to read-only viewing without
stopping the agent. Only one viewer controls input at a time. Resizing an attached
pane resizes the agent's terminal. Native agents receive the initial task immediately
but can pause at their own setup/trust prompts. Task status follows the agent's saved
turn events: a final response marks the task completed and freezes its timer, even
when the terminal remains open. **Terminal open** identifies these attachable sessions;
**Close terminal** releases the process without relabelling finished work as cancelled.
Submitting a follow-up makes the task running again. Verification is available after
a task finishes; new work invalidates its previous grade. Process status is reported
separately as `processStatus` by the API and CLI.

Completion tracking reads Jive session messages, Codex rollout task events, and
Claude transcript turn events for the run's exact workspace. It ignores tool/graph
completion and child-agent sessions. Existing recorded native history is recognized
without rerunning tasks. Codex/Claude session data must remain available in their
normal local storage (or the `CODEX_HOME`/`CLAUDE_CONFIG_DIR` saved when launched).

Only expanded panes with **Terminal** selected create a browser terminal and live
connection. Collapsing a run, filtering it out, or switching to **Logs** disposes of
the renderer and connection. Reopening restores the current screen and bounded
scrollback. Hidden browser tabs also release terminal connections. Browser refreshes
and dashboard restarts reconnect read-only. Closed sessions retain their final screen.
Existing headless runs have logs only and cannot
be converted into interactive terminal sessions after launch.

To start a managed terminal directly from the CLI and return its run ID:

```sh
bun run taskground run intent_routing --agent jive --terminal --json
```

New runs are retained under `~/.local/share/taskground/<project-id>/runs/`, outside
the repository. Set `TASKGROUND_DATA_DIR` to change the project data directory, or
use `--runs-dir` for a particular run. Custom managed run roots are registered for
discovery. Existing `taskground/task_runs/` history is read in place. Nothing is
automatically deleted. `bun run taskground runs --json` lists the same managed runs.

### Model and thinking effort

The model picker uses Jive's curated catalogue and OpenRouter capability metadata,
the installed Codex model cache, or Claude's metadata-only initialization response.
Thinking effort offers only the selected model's supported levels and resets when
the agent or model changes. Unknown or unsupported capabilities keep the agent's
default effort. No inference is performed while loading these choices. CLI runs can
also set `--model ID --effort LEVEL`; both selections are retained in the run record.
Older Jive source commits must support `--effort` to use an explicit effort override.

### Source selection

Each new run snapshots the primary Git worktree, even when Taskground is launched
from a linked worktree. Choose in the dashboard or use:

```sh
# Current branch including staged, unstaged and non-ignored untracked files (default)
bun run taskground run intent_routing --headless --source working
# Latest LOCAL commit on the primary worktree's currently checked-out branch
bun run taskground run intent_routing --headless --source head
# Specific commit, tag or revision, resolved to an immutable commit SHA
bun run taskground run intent_routing --headless --source commit --commit abc1234
```

The snapshot supplies both Jive's source and the task definitions/verifiers. An old
commit must contain the selected task. It does not switch branches, edit the index,
pull from a remote, or change the primary worktree. Credentials, previous runs,
dependency folders, caches and recording media are excluded from the source copy.
Jive dependencies are copied separately when manifests match, or installed in the
snapshot with the selected lockfile and lifecycle scripts disabled. Codex/Claude
use their installed executables. Every run records its branch, resolved commit,
selection mode and source hash; later source edits affect only subsequent runs.

### Metrics

Metrics are derived from saved events and work for live runs and retained history.
`status RUN_ID --json` also includes them. Jive reports planner requests, executed Bash/Jev/Synth steps, graph outcomes,
average executed leaf nodes per finished graph, logical Jev evaluations and
instrumented HTTP attempts/retries, Synth calls and prompt/output token usage, active/peak/average concurrency,
repeat iterations and foreach items. Average concurrency is weighted by
time over graph execution, excluding planner waiting and loop container nodes.
Streaming graph wrappers are not separate executions. Runtime excludes preparation
and grading. These counters show activity, not an estimated percentage complete.
Codex/Claude expose turns and tool operations where their event logs provide them;
Jive-only metrics and unavailable historical telemetry are shown as unavailable.
Native Codex/Claude terminal screens are not parsed into structured task metrics.

For Cognitive Delegation work, interpret planner turns, Jev calls, and Synth calls
as separate cognitive allocations rather than interchangeable "LLM calls". A good
result is not merely fewer calls: correctness/verification must hold while
transformation volume grows without frontier-planner work growing proportionally.
Future retained metrics should add planner token usage, verification pass rate,
and frontier escalations per completed transformation. Synth prompt/output usage
is retained directly from each bounded generation response.

### Optional video recording

```sh
bun run taskground run intent_routing --agent jive --headless --detach --record \
  --width 1920 --height 1080 --columns 120 --rows 36
# After the run stops:
bun run taskground export RUN_ID
```

Recording captures a readable, timestamped **headless transcript**, not the native
interactive agent UI or your desktop. It is opt-in before launch; runs without
capture cannot later produce an exact video. The original structured logs remain
available for inspection. Terminal columns/rows determine text wrapping; width/height
determine MP4 pixels. The agent receives `COLUMNS`/`LINES` but still runs headlessly.
Export renders the chosen size with original timing and saves `recording.mp4` beside
the run, available to download from its dashboard panel. Both transcript and video
stay outside the repository; recording with an in-repo `--runs-dir` is rejected.
Export requires FFmpeg, plus its ASS/subtitles filter or a local ImageMagick renderer.
Video export is available in **Headless logs** mode; native PTY sessions currently
retain their terminal output and final screen, without MP4 export.

Local interactive CLI runs do not submit the task automatically. Jive and Claude open with
the task prefilled as an editable draft; press Enter when ready. Jive also exposes
this directly as `jive --prefill "your draft"`, while `--prompt` still submits
immediately. Claude uses its native `--prefill` option (verified in 2.1.278, hidden
from its help). The installed Codex CLI has no equivalent startup option, so it
opens with an empty composer: enter `Read TASK.md and README.md, then complete the
task.` or paste the full prompt from `../prompt.txt`.

## Layout

```text
taskground/
  app/                      # Dashboard server, web UI and run management
  task_definitions/<task>/
    task.json               # ID, description, optional setup/verifier argv
    instruction.md          # Identical task instruction for every agent
    workspace/              # Agent-visible starting files
    verifier/reference.json # Held-out answers; not copied to workspace
    SOURCE.json             # Attribution, upstream revision/checksums, sampling
  _shared/                  # Dev scoring and deterministic verifiers
  task_runs/                # Legacy run history; still discovered

~/.local/share/taskground/<project-id>/runs/<run-id>/
    source/                 # Frozen source + selected task definitions
    definition/             # Definition + shared verifier snapshot
    workspace/              # Fresh Git repository; .env, inputs, work/ outputs
    prompt.txt              # Exact initial prompt
    run.json                # Configuration, process state, provenance
    result.json             # Final execution/verification result
    grading.json            # Latest grading, independent of a live terminal process
    logs/                   # Headless output, native terminal bytes, supervisor logs
    terminal.json           # Private live PTY endpoint (while running)
    terminal-screen.json    # Final native screen and terminal dimensions
    verification/           # Every grading attempt and its logs
    recording.jsonl         # Optional timestamped headless transcript
    recording.mp4           # Created on demand by export
```

| Task | Size | Expected individual helper calls |
| --- | --- | --- |
| `sembench_movie` | 120 test reviews, 12 dev reviews, three analytical queries reusing judgments | 132 |
| `product_matching` | 120 test pairs and 20 dev pairs | 140 |
| `intent_routing` | 154 test requests across 77 intents; labeled examples supplied for reference | 154 |
| `conversation_eval` | Three dev rounds of 20 responses + 10 pairs, then 40 test responses + 20 pairs | 150 |
| `slow_trace_search` | Profile and optimize a local Python trace-query engine; same-machine performance and held-out correctness checks | 0 |
| `cognitive_bulk_migration` | Migrate 24 independent natural-language adapter contracts with held-out behavior checks; useful for cognitive-allocation comparisons | ~24 |
| `search_latency` | Profile recurring, exploratory, and ingesting search traffic; choose experiments and reassess residual bottlenecks | ~12 (investigation-dependent) |
| `search_results_race` | Debug a local browser search client; deterministic response-order checks and browser evidence | 0 |
| `async_blocking_audit` | Explore a historical Home Assistant snapshot for blocking calls reachable from the event loop | Investigation-dependent |
| `error_handling_audit` | Trace failure handling in a pinned Prefect source subset and distinguish hidden failures from valid fallbacks | Investigation-dependent |
| `retry_audit` | Audit retry behavior in a pinned Airflow source subset, separating defective retries from polling and valid shared policies | Investigation-dependent |

The first four are frozen **development adaptations**, not official full-benchmark scores.
`cognitive_bulk_migration` is an original synthetic qualification workload; it
measures bounded transformation correctness and cognitive allocation, not broad
software-engineering quality.
The counts leave room below 200 for retries/refinements; they assume all five
conversation attributes are evaluated together per response. Intent examples do
not require a separate full inference pass. Fixtures are checked in: ordinary runs
need no dataset downloads. `SOURCE.json` records exact sources, sampling and rights.

## Credentials and profiles

Every prepared workspace receives a mode-0600 `.env` containing only
`OPENROUTER_API_KEY`. The run directory is mode 0700. The shell environment takes
precedence, followed by `--env-file FILE`, or the current checkout's `.env` and the
main checkout's `.env` when running in a Git worktree. Missing keys produce an empty
entry; Jive reports an error before launching if its key is absent. The other agents
can still use their normal authentication. Jive's Jev credentials/settings are
inherited or loaded from those same source env files, without copying them into
the task's `.env`.

All workspace READMEs receive the same line saying OpenRouter is optional,
using `deepseek/deepseek-v4-flash`, with at most **200 helper calls per task run**,
including calibration and retries. This is an instruction, not a metered or
enforced limit. It does not count the coding agent's own inference. Given the
same task and prompt override, Jive, Codex, and Claude receive identical task
instructions, README context, and prepared prompt text. Their native tools and
agent-level system instructions can differ.

Secrets are excluded from definition snapshots, run metadata, and workspace Git.
Agent stdout is captured as emitted: an agent that prints a secret can put it into
its own logs. Treat whole run folders as private; share selected artifacts only.
Local folder separation is not a sandbox and does not make held-out answers
inaccessible to an agent that deliberately leaves its workspace.

## Run and inspect

```sh
# Prepare a workspace without starting an agent or making API calls
bun run taskground prepare conversation_eval --agent jive --json

# Wait for a headless run; final summary is one JSON object on stdout
bun run taskground run intent_routing --agent jive --headless --json

# Return immediately with a run ID; a detached supervisor owns the agent
bun run taskground run intent_routing --agent jive --headless --detach --json

# Both commands work while the agent is running
bun run taskground status RUN_ID --json
bun run taskground logs RUN_ID --tail 30
bun run taskground stop RUN_ID --json
bun run taskground verify RUN_ID --json
```

`prepare` creates an inspectable workspace; `run` always creates a new run. To work
manually in a prepared workspace, change into its printed path and open an agent
with `TASK.md` as its task. Do not reuse previous run folders for benchmark retries.

Options: `--model ID`, `--prompt-file FILE`, `--env-file FILE`, optional
`--timeout SECONDS`, `--runs-dir DIR`, `--agent-bin PATH`, and repeatable
`--agent-arg=ARG`. Arguments are passed directly, not interpolated into shell code.
Codex receives a writable-workspace sandbox with network enabled. Claude headless
runs allow Read/Edit/Write/Bash/Glob/Grep. Interactive agents retain their normal
permission prompts. Use explicit agent arguments for additional local configuration.

Headless stdout/stderr are captured in `logs/`. Interactive runs inherit the terminal
instead of replacing the native UI; Jive session paths are collected in `run.json`.
Codex and Claude retain their normal interactive session history. `stop` requests
cancellation through the supervisor, which terminates the agent and its observed
descendants. Ctrl+C also forwards cancellation. An unexpected supervisor exit is
reported by `status`; detached processes that intentionally escape the supervisor's
process tree are outside this local runner's guarantees.

Execution status (`completed`, `failed`, `cancelled`, `timed_out`) and grading status
(`ungraded`, `passed`, `failed`, `error`) are separate. Verification is explicit,
uses the saved verifier/reference snapshot, and preserves each report. Changes to
that snapshot are detected. Correctness thresholds are provisional; method,
reproducibility, call-count compliance, and label leakage need trace review.

## Parent-agent workflow

Use `list --json` to select a task, then `run ... --headless --detach --json`. Keep
the returned ID. Poll `status`, inspect `logs` and workspace artifacts, then invoke
`verify` after execution stops. A zero agent exit code only means the process
completed; inspect `grading` and the referenced report before asserting success.
Verification can also inspect a manually completed `prepare` workspace. Preserve
failed runs as debugging evidence. A new attempt gets a new ID and starting state.

`status RUN_ID --json` reports lifecycle state (such as `running`) and paths to the
workspace and logs. `logs RUN_ID --tail 30` reads the latest captured output
without waiting for completion. Jive emits agent snapshots, Codex emits JSON
events, and Claude emits stream-JSON events; the underlying files in `logs/` can
also be read directly. Poll every few seconds rather than busy-looping. These
provide activity and intermediate artifacts, not a percentage-complete estimate;
a quiet log alone does not establish that the agent is stuck. `stop` can cancel
a run while retaining its partial artifacts.

Run records include the task snapshot hash, initial prompt, CLI command/version,
requested model/extra arguments, source revision/dirty flag/source-code hash,
timestamps, exit status and artifact paths. Native logs hold actual model events
where available. New runs retain their source snapshot as well as its hash. Legacy
runs may only contain a source hash. Global agent configuration is not snapshotted.

## Maintaining fixtures

```sh
python3 bin/prepare-taskground-data.py
```

This regeneration command uses pinned upstream revisions for SemBench and BANKING77,
the WDC archive, and the existing local HelpSteer2 task. It records source hashes,
strips test labels/answer-bearing metadata, and regenerates deterministic subsets.
It makes no model calls. Downloads live in `taskground/.cache/` (ignored). Review
fixture changes before accepting new upstream content. Public dev scorers are
generated copies of `_shared/score.py`; regenerate them after changing that helper.

## Fast debugging demos

The three coding tasks are original synthetic fixtures. They start with an intentional
defect and keep maintainers' reference fixes and held-out checks outside the agent's
workspace. No helper model calls are required. Start each attempt with a fresh run.

`slow_trace_search` uses Python's standard library. Setup creates deterministic trace
data. Its workspace README supplies correctness, quick workload, CPU profile, and
benchmark commands. Verification compares the optimized implementation with the
frozen starting implementation on the same machine; do not run performance grading
concurrently with other CPU-heavy work.

`search_latency` extends the profiling task to a local multi-tenant search endpoint
with caching, batched audit receipts, ingestion, and concurrent callers. Its Python
standard-library toolkit offers workload overviews, CPU profiles, structured event
traces, investigator-selected comparisons, and uninstrumented benchmarks. Separate
dashboard, exploratory, and ingesting-mixed performance gates reject partial
reference repairs; construction and ingestion costs are also measured. The agent designs its
own investigation; no graph or helper-call requirement is supplied. Bounded choices
between available experiments can drive an adaptive execution graph. The helper
estimate is an experiment-design expectation, not a quota or a measured result.
Held-out checks cover audit completeness, freshness, tenant isolation, concurrency,
and same-machine speedup. A prepared diagnostic toolkit does not guarantee that an
agent will use Jev; compare actual run traces to evaluate that behavior.

`search_results_race` requires Node 20+ and npm. Preparation installs pinned
Playwright and Chromium; the first setup may download them. On Linux, Chromium host
libraries must also be installed. Setup is outside the agent's timed execution.
After preparation, the app, browser commands, tests, and verifier run locally without
network access. Use `node scripts/browser.mjs start --headed` inside the prepared
workspace to show the demo, or omit `--headed` for headless operation. The CLI offers
DOM snapshots, input, clear, reload, network/console events, screenshots, and trace
capture through shell commands for all agent profiles. Run `node scripts/browser.mjs
stop` to save the trace and close its processes; direct manual browser sessions are
not managed by Taskground. The supplied `npm run check` intentionally fails on the
starting client. See the workspace README for evidence and regression-test requirements.

Maintainer validation (no agent/model calls):

```sh
python3 taskground/task_definitions/slow_trace_search/maintainer/smoke.py
python3 taskground/task_definitions/search_latency/maintainer/smoke.py
# Install browser dependencies once before running its maintainer smoke test:
node taskground/task_definitions/search_results_race/workspace/scripts/setup.mjs
node taskground/task_definitions/search_results_race/verifier/smoke.mjs
```

These checks validate that the seeded implementation fails and a reference fix passes.
They are fixture validation, not measured agent completion times. The data regeneration
script above only updates the four dataset adaptations. `bunfig.toml` scopes the
repository's `bun test` to `tests/`, so it does not discover task fixtures or retained
agent tests.

## Codebase exploration audits

`async_blocking_audit`, `error_handling_audit`, and `retry_audit` ask for an
evidence-backed audit in `work/findings.json` and `work/report.md`. Their workspaces
contain scoped, pinned upstream source with real historical defects, supporting
context, and legitimate lookalikes. Each workspace README defines its scope and
output format. These are source-reading tasks; installing or running the entire
upstream application is not required. Preparation and verification run locally
without fetching upstream repositories or contacting external services.

The Prefect and Airflow tasks also include local examples of expected behavior.
These teach the audit policy; they are identified separately from upstream code.
Each task's `SOURCE.json` records provenance, licenses, and fixture checksums.
Maintainer reference findings and grading data stay outside the prepared workspace.

The tasks leave search and follow-up choices to the agent. A useful intermediate
judgment can distinguish a genuine candidate from a lookalike, or identify the
caller, wrapper, or dependency that needs further inspection. No particular graph
or helper-call count is required. Evaluate Jev's contribution from execution traces,
including whether decisions changed subsequent investigation, rather than counting
calls alone.

The Prefect and Airflow task prompts include the same
[execution guidance](_shared/audit_execution_guidance.md) for every agent profile:
ground bounded judgments in source evidence, connect decisions to follow-up reads,
reuse an evidence ledger, and validate the documented output contract before
finishing. The guidance does not name a specific agent or require its tool APIs.

Automated grading checks the documented structured artifacts against a curated
reference. Passing is evidence of performance on that scoped fixture, not a proof
that an entire upstream repository is free of other defects. Explanation quality
and investigation method still need review. Maintainer checks exercise reference
submissions and invalid or misleading alternatives without model calls:

```sh
python3 taskground/task_definitions/async_blocking_audit/maintainer/smoke.py
python3 taskground/task_definitions/error_handling_audit/maintainer/smoke.py
python3 taskground/task_definitions/retry_audit/maintainer/smoke.py
```
