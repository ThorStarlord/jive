(() => {
  "use strict";

  const POLL_MS = 2000;
  const ACTIVE_STATUSES = new Set(["preparing", "starting", "running"]);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
  const state = {
    tasks: [],
    models: [],
    modelRequest: 0,
    runs: [],
    source: null,
    dataDirectory: "",
    token: "",
    loading: true,
    error: "",
    expanded: new Set(),
    details: new Map(),
    outputs: new Map(),
    outputViews: new Map(),
    outputErrors: new Map(),
    artifacts: new Map(),
    artifactErrors: new Map(),
    terminalSessions: new Map(),
    scrollPositions: new Map(),
    pendingFocusKey: "",
    pendingTerminalFocus: "",
    maximizedOutput: "",
    pollTimer: null,
    requestInFlight: false,
    configRequest: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const elements = {
    connection: $("#connection-state"),
    connectionLabel: $("#connection-label"),
    sourceBranch: $("#source-branch"),
    sourceRevision: $("#source-revision"),
    dataDirectory: $("#data-directory"),
    active: $("#stat-active"),
    activeNote: $("#stat-active-note"),
    completed: $("#stat-completed"),
    passRate: $("#stat-pass-rate"),
    gradedNote: $("#stat-graded-note"),
    median: $("#stat-median"),
    resultCount: $("#result-count"),
    runList: $("#run-list"),
    search: $("#run-search"),
    statusFilter: $("#status-filter"),
    agentFilter: $("#agent-filter"),
    newRunButton: $("#new-run-button"),
    dialog: $("#new-run-dialog"),
    form: $("#new-run-form"),
    closeDialog: $("#close-dialog"),
    cancelDialog: $("#cancel-dialog"),
    taskSelect: $("#task-select"),
    taskDescription: $("#task-description"),
    model: $("#model-input"),
    modelNotice: $("#model-notice"),
    effort: $("#effort-select"),
    effortNotice: $("#effort-notice"),
    executionMode: $("#execution-mode"),
    executionModeNotice: $("#execution-mode-notice"),
    timeout: $("#timeout-input"),
    commitField: $("#commit-field"),
    commit: $("#commit-input"),
    recordingEnabled: $("#recording-enabled"),
    recordingNotice: $("#recording-notice"),
    recordingOptions: $("#recording-options"),
    recordingPreset: $("#recording-preset"),
    recordingWidth: $("#recording-width"),
    recordingHeight: $("#recording-height"),
    recordingColumns: $("#recording-columns"),
    recordingRows: $("#recording-rows"),
    formError: $("#form-error"),
    submitRun: $("#submit-run"),
    toastRegion: $("#toast-region"),
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function append(parent, ...children) {
    for (const child of children) if (child) parent.append(child);
    return parent;
  }

  function normalizeError(error, fallback = "Something went wrong") {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined || options.mutation) headers.set("Content-Type", "application/json");
    if (options.mutation) {
      if (!state.token) throw new Error("The local mutation token is unavailable. Refresh and try again.");
      headers.set("X-Taskground-Token", state.token);
    }
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    let payload = null;
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
    } else if (!response.ok) {
      payload = await response.text().catch(() => "");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && payload.error
        ? String(payload.error)
        : typeof payload === "string" && payload.trim()
          ? payload.trim()
          : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function setConnection(kind, label) {
    elements.connection.classList.toggle("is-online", kind === "online");
    elements.connection.classList.toggle("is-error", kind === "error");
    elements.connectionLabel.textContent = label;
  }

  function captureScrollPositions() {
    for (const output of elements.runList.querySelectorAll("[data-output-id]")) {
      const distanceFromBottom = output.scrollHeight - output.scrollTop - output.clientHeight;
      state.scrollPositions.set(output.dataset.outputId, {
        top: output.scrollTop,
        left: output.scrollLeft,
        followTail: distanceFromBottom <= 12,
      });
    }
  }

  function captureViewState() {
    captureScrollPositions();
    const focusedTerminal = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest(".native-terminal-pane .xterm")
      : null;
    const focusedPane = focusedTerminal ? focusedTerminal.closest(".native-terminal-pane") : null;
    if (focusedPane) state.pendingTerminalFocus = focusedPane.dataset.terminalRun || "";
    const focused = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest("[data-focus-key]")
      : null;
    if (focused) state.pendingFocusKey = focused.dataset.focusKey || "";
  }

  function restoreViewState() {
    for (const output of elements.runList.querySelectorAll("[data-output-id]")) {
      const position = state.scrollPositions.get(output.dataset.outputId);
      if (position) {
        output.scrollTop = position.followTail ? output.scrollHeight : position.top;
        output.scrollLeft = position.left;
      } else {
        output.scrollTop = output.scrollHeight;
      }
    }
    if (state.pendingFocusKey) {
      const target = [...elements.runList.querySelectorAll("[data-focus-key]")]
        .find((candidate) => candidate.dataset.focusKey === state.pendingFocusKey);
      if (target) {
        try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      }
      state.pendingFocusKey = "";
    }
    if (state.pendingTerminalFocus) {
      const session = state.terminalSessions.get(state.pendingTerminalFocus);
      if (session && session.attached && session.pane.isConnected && session.terminal) session.terminal.focus();
      state.pendingTerminalFocus = "";
    }
  }

  async function loadConfig({ announceError = true, clearOnError = true } = {}) {
    if (state.configRequest) return state.configRequest;
    const request = (async () => {
      try {
        const config = await api("/api/config", { cache: "no-store" });
        state.token = config && typeof config.token === "string" ? config.token : "";
        return Boolean(state.token);
      } catch (error) {
        if (clearOnError) state.token = "";
        if (announceError) showToast(`Controls unavailable: ${normalizeError(error)}`, true);
        return false;
      }
    })();
    state.configRequest = request;
    try {
      return await request;
    } finally {
      if (state.configRequest === request) state.configRequest = null;
    }
  }

  async function refreshState({ announceError = false } = {}) {
    if (state.requestInFlight || document.hidden) return;
    state.requestInFlight = true;
    try {
      const payload = await api("/api/state");
      if (!payload || !Array.isArray(payload.tasks) || !Array.isArray(payload.runs)) {
        throw new Error("The server returned an invalid state response.");
      }
      captureViewState();
      state.tasks = payload.tasks;
      state.runs = payload.runs;
      state.source = payload.source || null;
      state.dataDirectory = payload.dataDirectory || "";
      if (!state.token && typeof payload.token === "string") state.token = payload.token;
      state.loading = false;
      state.error = "";
      updateTaskOptions();
      if (document.hidden) return;
      render();
      setConnection("online", "Live");
      await refreshExpandedRuns();
    } catch (error) {
      captureViewState();
      state.loading = false;
      state.error = normalizeError(error, "Could not reach the local Taskground server.");
      setConnection("error", "Disconnected");
      render();
      if (announceError) showToast(state.error, true);
    } finally {
      state.requestInFlight = false;
    }
  }

  async function refreshExpandedRuns() {
    const visibleIds = filteredRuns().map((run) => run.id).filter((id) => state.expanded.has(id));
    if (!visibleIds.length) return;
    await Promise.all(visibleIds.map(async (id) => {
      const [runResult, outputResult, artifactsResult] = await Promise.allSettled([
        api(`/api/runs/${encodeURIComponent(id)}`),
        api(`/api/runs/${encodeURIComponent(id)}/output`),
        api(`/api/runs/${encodeURIComponent(id)}/artifacts`),
      ]);
      if (runResult.status === "fulfilled" && runResult.value) state.details.set(id, runResult.value);
      if (outputResult.status === "fulfilled") {
        const output = outputResult.value;
        state.outputs.set(id, output && typeof output.text === "string" ? output.text : "");
        state.outputErrors.delete(id);
      } else {
        state.outputErrors.set(id, normalizeError(outputResult.reason, "Output unavailable."));
      }
      if (artifactsResult.status === "fulfilled") {
        const payload = artifactsResult.value;
        state.artifacts.set(id, payload && Array.isArray(payload.files) ? payload.files : []);
        state.artifactErrors.delete(id);
      } else {
        state.artifactErrors.set(id, normalizeError(artifactsResult.reason, "Deliverables unavailable."));
      }
    }));
    if (document.hidden) return;
    captureViewState();
    renderRuns();
  }

  function schedulePolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (!document.hidden) state.pollTimer = window.setInterval(() => refreshState(), POLL_MS);
  }

  function updateTaskOptions() {
    const previous = elements.taskSelect.value;
    const wasFocused = document.activeElement === elements.taskSelect;
    const signature = state.tasks.map((task) => `${task.id}:${task.title || ""}`).join("|");
    if (elements.taskSelect.dataset.signature === signature) return;
    elements.taskSelect.replaceChildren();
    const placeholder = node("option", "", state.tasks.length ? "Select a task…" : "No tasks available");
    placeholder.value = "";
    elements.taskSelect.append(placeholder);
    for (const task of state.tasks) {
      const option = node("option", "", task.title ? `${task.title} · ${task.id}` : task.id);
      option.value = task.id;
      elements.taskSelect.append(option);
    }
    elements.taskSelect.dataset.signature = signature;
    if (state.tasks.some((task) => task.id === previous)) elements.taskSelect.value = previous;
    elements.taskSelect.disabled = state.tasks.length === 0;
    updateTaskDescription();
    if (wasFocused) elements.taskSelect.focus();
  }

  function updateTaskDescription() {
    const task = state.tasks.find((item) => item.id === elements.taskSelect.value);
    elements.taskDescription.textContent = task ? (task.description || task.title || task.id) : "Choose a benchmark definition.";
  }

  function render() {
    renderSource();
    renderSummary();
    renderRuns();
  }

  function renderSource() {
    elements.sourceBranch.textContent = state.source && state.source.branch ? state.source.branch : "No branch";
    elements.sourceRevision.textContent = state.source && state.source.revision ? shortRevision(state.source.revision) : "No revision";
    elements.sourceRevision.title = state.source && state.source.revision ? state.source.revision : "";
    elements.dataDirectory.textContent = state.dataDirectory ? `Run storage  ${state.dataDirectory}` : "Run storage unavailable";
    elements.dataDirectory.title = state.dataDirectory || "";
  }

  function renderSummary() {
    const active = state.runs.filter((run) => ACTIVE_STATUSES.has(run.status));
    const completed = state.runs.filter((run) => TERMINAL_STATUSES.has(run.status));
    const graded = state.runs.filter((run) => run.grading && ["passed", "failed"].includes(run.grading.status));
    const passed = graded.filter((run) => run.grading.status === "passed");
    const durations = completed.map(runElapsed).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const median = durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null;
    elements.active.textContent = String(active.length);
    elements.activeNote.textContent = active.length === 1 ? "run in flight" : "runs in flight";
    elements.completed.textContent = String(completed.length);
    elements.passRate.textContent = graded.length ? `${Math.round((passed.length / graded.length) * 100)}%` : "—";
    elements.gradedNote.textContent = graded.length ? `${graded.length} verified ${graded.length === 1 ? "run" : "runs"}` : "no verified runs";
    elements.median.textContent = median === null ? "—" : formatDuration(median);
  }

  function filteredRuns() {
    const query = elements.search.value.trim().toLowerCase();
    const status = elements.statusFilter.value;
    const agent = elements.agentFilter.value;
    return [...state.runs]
      .filter((run) => {
        if (agent !== "all" && run.agent !== agent) return false;
        if (status === "active" && !ACTIVE_STATUSES.has(run.status)) return false;
        if (status === "failed" && !["failed", "timed_out"].includes(run.status)) return false;
        if (!["all", "active", "failed"].includes(status) && run.status !== status) return false;
        if (!query) return true;
        const haystack = [run.id, run.task, run.title, run.agent, run.model, run.status, run.source && run.source.branch, run.source && run.source.revision]
          .filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => {
        const aActive = ACTIVE_STATUSES.has(a.status) ? 1 : 0;
        const bActive = ACTIVE_STATUSES.has(b.status) ? 1 : 0;
        return bActive - aActive || Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
      });
  }

  function renderRuns() {
    const runs = filteredRuns();
    cleanupHiddenTerminals(runs);
    if (state.maximizedOutput && (!state.expanded.has(state.maximizedOutput) || !runs.some((run) => run.id === state.maximizedOutput))) {
      state.maximizedOutput = "";
    }
    document.body.classList.toggle("has-maximized-output", Boolean(state.maximizedOutput));
    elements.runList.setAttribute("aria-busy", String(state.loading));
    elements.resultCount.textContent = state.loading
      ? "Loading run history…"
      : `${runs.length} of ${state.runs.length} ${state.runs.length === 1 ? "run" : "runs"}`;
    elements.runList.replaceChildren();
    if (state.loading) {
      elements.runList.append(stateCard("", "Loading Taskground", "Reading tasks and retained runs from this machine.", true));
      return;
    }
    if (state.error && !state.runs.length) {
      const card = stateCard("!", "Taskground is unavailable", state.error);
      const retry = node("button", "button button-secondary", "Retry connection");
      retry.type = "button";
      retry.addEventListener("click", () => refreshState({ announceError: true }));
      card.append(retry);
      elements.runList.append(card);
      return;
    }
    if (!state.runs.length) {
      const card = stateCard("＋", "No benchmark runs yet", state.tasks.length ? "Start a run to create the first retained workspace." : "No task definitions are currently available.");
      if (state.tasks.length) {
        const start = node("button", "button button-primary", "Start first run");
        start.type = "button";
        start.addEventListener("click", openDialog);
        card.append(start);
      }
      elements.runList.append(card);
      return;
    }
    if (!runs.length) {
      elements.runList.append(stateCard("⌕", "No matching runs", "Adjust the search or filters to see more history."));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const run of runs) fragment.append(renderRun(run));
    elements.runList.append(fragment);
    // A detail poll can finish before the next frame; restore now so it never
    // saves the replacement pane's initial scroll position over the user's.
    restoreViewState();
    requestAnimationFrame(() => {
      drawCharts();
      activateVisibleTerminals();
    });
  }

  function stateCard(icon, title, message, loading = false) {
    const card = node("div", `state-card${loading ? " loading-state" : ""}`);
    card.append(loading ? node("span", "loader") : node("span", "state-icon", icon));
    append(card, node("strong", "", title), node("p", "", message));
    return card;
  }

  function renderRun(summaryRun) {
    const expanded = state.expanded.has(summaryRun.id);
    const run = expanded ? { ...summaryRun, ...(state.details.get(summaryRun.id) || {}) } : summaryRun;
    const item = node("article", `run-item${expanded ? " is-expanded" : ""}`);
    item.dataset.runId = run.id;
    const button = node("button", "run-summary");
    button.type = "button";
    button.dataset.focusKey = `summary:${run.id}`;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-controls", `run-detail-${safeId(run.id)}`);
    button.addEventListener("click", () => toggleRun(run.id));

    const task = node("span", "run-task");
    const glyph = node("span", "agent-glyph", (run.agent || "?").slice(0, 1));
    glyph.setAttribute("aria-hidden", "true");
    const taskText = node("span");
    append(taskText, node("strong", "", taskTitle(run.task)), node("small", "", run.id));
    append(task, glyph, taskText);

    const agent = node("span", "agent-name", run.agent || "Unknown");
    const status = node("span", "run-status");
    const model = node("span", "status-model", run.model || "Agent default");
    model.title = `Model: ${run.model || "Agent default"}`;
    const effort = node("span", "status-effort", `Effort: ${run.effort || "default"}`);
    effort.title = `Reasoning effort: ${run.effort || "Agent default"}`;
    append(status, node("span", `status-badge status-${run.status || "unknown"}`, statusLabel(run.status)), model, effort);
    if (run.mode === "terminal" && run.processStatus === "running" && !ACTIVE_STATUSES.has(run.status)) status.append(node("span", "status-effort", "Terminal open"));
    const elapsed = node("span", "run-time", formatDuration(runElapsed(run), ACTIVE_STATUSES.has(run.status)));
    const date = node("span", "run-date", formatDate(run.createdAt));
    date.append(node("small", "", formatTime(run.createdAt)));
    const chevron = node("span", "chevron", "⌄");
    chevron.setAttribute("aria-hidden", "true");
    append(button, task, agent, status, elapsed, date, chevron);
    item.append(button);
    if (expanded) item.append(renderDetail(run));
    return item;
  }

  function renderDetail(run) {
    const detail = node("div", "run-detail");
    detail.id = `run-detail-${safeId(run.id)}`;
    const head = node("div", "detail-head");
    const headLeft = node("div", "detail-head-left");
    const gradeStatus = run.grading && run.grading.status ? run.grading.status : "ungraded";
    append(headLeft, node("span", `grade-badge grade-${gradeStatus}`, gradeStatus), node("code", "", run.workspace || run.directory || "Workspace pending"));
    const actions = node("div", "detail-actions");
    renderActions(run, actions);
    append(head, headLeft, actions);
    detail.append(head);

    const metrics = run.metrics || {};
    const strip = node("div", "metric-strip");
    const values = [
      ["Elapsed", formatDuration(runElapsed(run), ACTIVE_STATUSES.has(run.status))],
      ["Planner turns", metric(metrics, "plannerTurns")],
      ["Steps", metric(metrics, "steps")],
      ["Graphs", graphMetric(metrics)],
      ["Avg graph", decimalMetric(metrics, "avgGraphSize")],
      ["JEV calls", metric(metrics, "jevCalls")],
      ["Synth calls", metric(metrics, "synthCalls")],
      ["Synth prompt tok", metric(metrics, "synthPromptTokens")],
      ["Synth output tok", metric(metrics, "synthCompletionTokens")],
      ["JEV attempts", metric(metrics, "jevAttempts")],
      ["JEV retries", metric(metrics, "jevRetries")],
      ["Parallel now", metric(metrics, "currentParallelism")],
      ["Parallel peak", metric(metrics, "peakParallelism")],
      ["Parallel avg", decimalMetric(metrics, "avgParallelism")],
      ["Loop work", loopMetric(metrics)],
    ];
    for (const [label, value] of values) {
      const cell = node("div", "metric");
      append(cell, node("span", "", label), node("strong", "", value));
      strip.append(cell);
    }
    detail.append(strip);

    const grid = node("div", "detail-grid");
    const main = node("div", "detail-stack");
    main.append(renderOutput(run), renderCharts(run));
    const side = node("div", "detail-stack");
    side.append(renderProvenance(run), renderArtifacts(run), renderGrading(run));
    append(grid, main, side);
    detail.append(grid);
    if (run.error) detail.append(node("p", "run-error", run.error));
    return detail;
  }

  function renderActions(run, parent) {
    if (ACTIVE_STATUSES.has(run.status)) parent.append(actionButton("Cancel", "button-danger", () => mutateRun(run.id, "stop", "Cancellation requested."), `cancel:${run.id}`));
    else if (run.mode === "terminal" && run.processStatus === "running") parent.append(actionButton("Close terminal", "button-secondary", () => mutateRun(run.id, "stop", "Terminal close requested."), `cancel:${run.id}`));
    if (TERMINAL_STATUSES.has(run.status) || run.status === "ready") parent.append(actionButton("Verify", "button-secondary", () => mutateRun(run.id, "verify", "Verification finished."), `verify:${run.id}`));
    if (run.recording) {
      const exportState = run.export && run.export.status;
      if (exportState === "ready") {
        const download = node("a", "button button-primary", "Download MP4");
        download.href = `/api/runs/${encodeURIComponent(run.id)}/recording`;
        download.setAttribute("download", `${run.id}.mp4`);
        download.dataset.focusKey = `recording:${run.id}`;
        parent.append(download);
      } else {
        const exportButton = actionButton(exportState === "exporting" ? "Exporting…" : exportState === "error" ? "Retry export" : "Export recording", "button-quiet", () => mutateRun(run.id, "export", "Recording export started.", {}), `recording:${run.id}`);
        exportButton.disabled = exportState === "exporting" || !TERMINAL_STATUSES.has(run.status);
        if (exportState === "error" && run.export.error) exportButton.title = run.export.error;
        parent.append(exportButton);
      }
    }
  }

  function actionButton(label, className, handler, focusKey) {
    const button = node("button", `button ${className}`, label);
    button.type = "button";
    if (focusKey) button.dataset.focusKey = focusKey;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      try { await handler(); } finally { button.disabled = false; }
    });
    return button;
  }

  function renderOutput(run) {
    const native = runMode(run) === "terminal";
    const panel = detailPanel("Output", native ? "native terminal" : ACTIVE_STATUSES.has(run.status) ? "live tail" : "terminal log");
    const view = state.outputViews.get(run.id) || (native ? "terminal" : "logs");
    const viewId = `output-${safeId(run.id)}-${view}`;
    const maximized = state.maximizedOutput === run.id;
    panel.classList.add("output-panel");
    panel.classList.toggle("is-maximized", maximized);
    const maximize = node("button", "panel-control", maximized ? "Restore" : "Maximize");
    maximize.type = "button";
    maximize.dataset.focusKey = `maximize:${run.id}`;
    maximize.setAttribute("aria-pressed", String(maximized));
    maximize.setAttribute("aria-label", `${maximized ? "Restore" : "Maximize"} terminal output for ${run.id}`);
    maximize.addEventListener("click", () => {
      captureViewState();
      state.maximizedOutput = maximized ? "" : run.id;
      renderRuns();
    });
    $(".panel-header-tools", panel).append(maximize);
    const tabs = node("div", "output-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", `Output views for ${run.id}`);
    const views = ["logs", "terminal"];
    for (const name of views) {
      const tab = node("button", "output-tab", name === "logs" ? "Logs" : "Terminal");
      tab.type = "button";
      tab.id = `output-tab-${safeId(run.id)}-${name}`;
      tab.dataset.focusKey = `output-tab:${run.id}:${name}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(view === name));
      tab.setAttribute("aria-controls", `output-${safeId(run.id)}-${name}`);
      tab.tabIndex = view === name ? 0 : -1;
      const select = target => {
        captureViewState();
        state.outputViews.set(run.id, target);
        state.pendingFocusKey = `output-tab:${run.id}:${target}`;
        renderRuns();
      };
      tab.addEventListener("click", () => select(name));
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        select(event.key === "Home" ? "logs" : event.key === "End" ? "terminal" : views[(views.indexOf(name) + 1) % views.length]);
      });
      tabs.append(tab);
    }
    panel.append(tabs);
    if (view === "terminal" && native) {
      panel.append(nativeTerminalPane(run));
      return panel;
    }
    if (view === "terminal") {
      const unavailable = node("div", "terminal-unavailable");
      unavailable.id = viewId;
      unavailable.setAttribute("role", "tabpanel");
      unavailable.setAttribute("aria-labelledby", `output-tab-${safeId(run.id)}-${view}`);
      append(
        unavailable,
        node("strong", "", "Native terminal unavailable"),
        node("p", "", "This run uses headless logs and has no interactive PTY. Open Logs to review its captured transcript."),
      );
      panel.append(unavailable);
      return panel;
    }
    const output = node("pre", "terminal-output");
    output.id = viewId;
    output.dataset.outputId = `${run.id}:${view}`;
    output.dataset.focusKey = `output:${run.id}:${view}`;
    output.tabIndex = 0;
    output.setAttribute("role", "tabpanel");
    output.setAttribute("aria-labelledby", `output-tab-${safeId(run.id)}-${view}`);
    const error = state.outputErrors.get(run.id);
    const text = state.outputs.get(run.id);
    if (error) {
      output.classList.add("terminal-empty");
      output.textContent = error;
    } else if (text === undefined) {
      output.classList.add("terminal-empty");
      output.textContent = "Loading output…";
    } else if (!text) {
      output.classList.add("terminal-empty");
      output.textContent = ACTIVE_STATUSES.has(run.status) ? "Waiting for agent output…" : "No terminal output was captured.";
    } else {
      output.textContent = text;
    }
    panel.append(output);
    return panel;
  }

  function runMode(run) {
    return run && run.mode === "terminal" ? "terminal" : "headless";
  }

  function cleanupHiddenTerminals(visibleRuns) {
    const visible = new Map(visibleRuns.map((run) => [run.id, { ...run, ...(state.details.get(run.id) || {}) }]));
    for (const [id] of state.terminalSessions) {
      const run = visible.get(id);
      const view = run ? state.outputViews.get(id) || (runMode(run) === "terminal" ? "terminal" : "logs") : "";
      if (!run || !state.expanded.has(id) || runMode(run) !== "terminal" || view !== "terminal") disposeTerminalSession(id);
    }
  }

  function nativeTerminalPane(run) {
    let session = state.terminalSessions.get(run.id);
    if (!session) session = createTerminalSession(run);
    session.run = run;
    session.pane.id = `output-${safeId(run.id)}-terminal`;
    session.pane.setAttribute("aria-labelledby", `output-tab-${safeId(run.id)}-terminal`);
    session.caption.textContent = `${run.agent || "Agent"} · ${run.model || "default model"}`;
    session.caption.title = session.caption.textContent;
    updateTerminalUi(session);
    return session.pane;
  }

  function createTerminalSession(run) {
    const pane = node("div", "native-terminal-pane");
    pane.dataset.terminalRun = run.id;
    pane.setAttribute("role", "tabpanel");
    const bar = node("div", "terminal-toolbar");
    const caption = node("span", "terminal-caption", `${run.agent || "Agent"} · ${run.model || "default model"}`);
    const tools = node("span", "terminal-tools");
    const status = node("span", "terminal-connection", "Preparing terminal…");
    status.setAttribute("role", "status");
    const control = node("button", "panel-control terminal-control", "Attach");
    control.type = "button";
    control.dataset.focusKey = `terminal-control:${run.id}`;
    control.disabled = true;
    append(tools, status, control);
    append(bar, caption, tools);
    const host = node("div", "native-terminal-host");
    host.dataset.focusKey = `output:${run.id}:terminal`;
    host.setAttribute("aria-label", `Terminal for ${run.id}`);
    const scroll = node("div", "native-terminal-scroll");
    scroll.append(host);
    const help = node("p", "terminal-help", "Read-only by default. Attach to type; detaching leaves the agent running until it exits or you cancel it.");
    append(pane, bar, scroll, help);

    const session = {
      id: run.id,
      run,
      pane,
      caption,
      host,
      scroll,
      help,
      status,
      control,
      terminal: null,
      socket: null,
      observer: null,
      inputDisposable: null,
      parserDisposables: [],
      reconnectTimer: null,
      resizeTimer: null,
      resizeFrame: null,
      layoutFrame: null,
      reconnectAttempt: 0,
      attached: false,
      available: false,
      exited: false,
      disposed: false,
      lastSentSize: "",
      exitCode: null,
      error: "",
      renderQueue: Promise.resolve(),
    };
    state.terminalSessions.set(run.id, session);

    control.addEventListener("click", () => toggleTerminalControl(session));
    updateTerminalUi(session);
    return session;
  }

  function initializeTerminal(session) {
    if (session.terminal || session.disposed || document.hidden) return;
    const TerminalConstructor = window.Terminal;
    if (typeof TerminalConstructor !== "function") {
      session.error = "The terminal component failed to load.";
      updateTerminalUi(session);
      return;
    }
    session.terminal = new TerminalConstructor({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: {
        background: "#0b1015",
        foreground: "#d0ded8",
        cursor: "#ffad73",
        cursorAccent: "#0b1015",
        selectionBackground: "#35516b",
        black: "#101820",
        brightBlack: "#6f7b85",
        red: "#f2777a",
        brightRed: "#ff8b8f",
        green: "#99cc99",
        brightGreen: "#b5e0b5",
        yellow: "#ffcc66",
        brightYellow: "#ffe099",
        blue: "#6699cc",
        brightBlue: "#8bb8e8",
        magenta: "#cc99cc",
        brightMagenta: "#e0b5e0",
        cyan: "#66cccc",
        brightCyan: "#99e0e0",
        white: "#d0d0d0",
        brightWhite: "#ffffff",
      },
    });
    suppressBrowserTerminalReplies(session);
    session.terminal.open(session.host);
    session.inputDisposable = session.terminal.onData((data) => {
      if (!session.attached || !session.socket || session.socket.readyState !== WebSocket.OPEN) return;
      sendTerminalMessage(session, { type: "input", data });
    });
    session.observer = new ResizeObserver(() => scheduleTerminalResize(session));
    session.observer.observe(session.scroll);
    connectTerminal(session);
  }

  function suppressBrowserTerminalReplies(session) {
    const parser = session.terminal.parser;
    const consume = () => true;
    // The supervisor's headless terminal is authoritative for emulator query
    // replies. Rendering the same query here must never inject a second reply.
    session.parserDisposables.push(
      parser.registerCsiHandler({ final: "n" }, consume),
      parser.registerCsiHandler({ prefix: "?", final: "n" }, consume),
      parser.registerCsiHandler({ final: "c" }, consume),
      parser.registerCsiHandler({ prefix: ">", final: "c" }, consume),
      parser.registerCsiHandler({ final: "t" }, consume),
      parser.registerCsiHandler({ intermediates: "$", final: "p" }, consume),
      parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, consume),
      parser.registerDcsHandler({ intermediates: "$", final: "q" }, consume),
    );
    for (const identifier of [4, 10, 11, 12]) {
      session.parserDisposables.push(parser.registerOscHandler(identifier, (data) => data.includes("?")));
    }
  }

  function activateVisibleTerminals() {
    if (document.hidden) return;
    for (const session of state.terminalSessions.values()) {
      if (!session.pane.isConnected) continue;
      initializeTerminal(session);
      if (session.attached) scheduleTerminalResize(session);
      else scheduleReadonlyTerminalLayout(session);
      if (!session.socket && !session.exited && !session.disposed) connectTerminal(session);
    }
  }

  function connectTerminal(session) {
    if (document.hidden || session.disposed || session.exited || session.socket || session.reconnectTimer) return;
    if (!state.token) {
      session.status.textContent = "Preparing terminal…";
      scheduleTerminalReconnect(session);
      return;
    }
    session.error = "";
    session.status.textContent = session.reconnectAttempt ? "Reconnecting…" : "Preparing terminal…";
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${window.location.host}/api/runs/${encodeURIComponent(session.id)}/terminal`;
    let socket;
    try {
      socket = new WebSocket(url, ["taskground", state.token]);
    } catch (error) {
      session.error = normalizeError(error, "Could not open terminal connection.");
      updateTerminalUi(session);
      scheduleTerminalReconnect(session);
      return;
    }
    session.socket = socket;
    socket.addEventListener("open", () => {
      if (session.socket !== socket || session.disposed) return;
      session.reconnectAttempt = 0;
      session.status.textContent = "Read only";
      updateTerminalUi(session);
    });
    socket.addEventListener("message", (event) => handleTerminalMessage(session, event.data));
    socket.addEventListener("error", () => {
      if (session.socket === socket) session.status.textContent = "Terminal connection interrupted";
    });
    socket.addEventListener("close", () => {
      if (session.socket !== socket) return;
      session.socket = null;
      session.attached = false;
      session.available = false;
      if (session.terminal) session.terminal.options.disableStdin = true;
      updateTerminalUi(session);
      scheduleReadonlyTerminalLayout(session);
      if (!session.disposed && !session.exited) scheduleTerminalReconnect(session);
    });
  }

  function handleTerminalMessage(session, raw) {
    if (session.disposed) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message.type !== "string") return;
    if (message.type === "snapshot") {
      const data = typeof message.data === "string" ? message.data : "";
      queueTerminalRender(session, () => {
        if (!session.terminal) return Promise.resolve();
        const cols = clampDimension(message.cols, 40, 300);
        const rows = clampDimension(message.rows, 10, 100);
        if (cols && rows) session.terminal.resize(cols, rows);
        session.terminal.reset();
        return writeTerminal(session, data).then(() => {
          if (!session.attached) layoutReadonlyTerminal(session);
        });
      });
      session.error = "";
    } else if (message.type === "output") {
      session.error = "";
      if (typeof message.data === "string") queueTerminalRender(session, () => writeTerminal(session, message.data));
    } else if (message.type === "control") {
      const wasAttached = session.attached;
      session.error = "";
      session.attached = message.attached === true;
      session.available = message.available === true;
      if (session.attached && !wasAttached) session.lastSentSize = "";
      if (session.terminal) session.terminal.options.disableStdin = !session.attached;
      updateTerminalUi(session);
      if (session.attached) {
        scheduleTerminalResize(session);
        if (session.terminal) session.terminal.focus();
      } else scheduleReadonlyTerminalLayout(session);
    } else if (message.type === "exit") {
      session.exited = true;
      session.attached = false;
      session.available = false;
      session.exitCode = Number.isInteger(message.exitCode) ? message.exitCode : null;
      if (session.terminal) session.terminal.options.disableStdin = true;
      updateTerminalUi(session);
      scheduleReadonlyTerminalLayout(session);
    } else if (message.type === "error") {
      session.error = typeof message.message === "string" ? message.message : "Terminal unavailable.";
      updateTerminalUi(session);
    }
  }

  function queueTerminalRender(session, operation) {
    session.renderQueue = session.renderQueue.then(() => session.disposed ? undefined : operation()).catch(() => {});
  }

  function writeTerminal(session, data) {
    if (!session.terminal || session.disposed) return Promise.resolve();
    return new Promise((resolve) => session.terminal.write(data, resolve));
  }

  function toggleTerminalControl(session) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN || session.exited) return;
    if (session.attached) {
      session.attached = false;
      session.available = true;
      if (session.terminal) session.terminal.options.disableStdin = true;
      sendTerminalMessage(session, { type: "detach" });
      updateTerminalUi(session);
      scheduleReadonlyTerminalLayout(session);
    } else {
      session.status.textContent = "Requesting control…";
      session.control.disabled = true;
      sendTerminalMessage(session, { type: "attach" });
    }
  }

  function sendTerminalMessage(session, message) {
    if (session.socket && session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }

  function updateTerminalUi(session) {
    const connected = session.socket && session.socket.readyState === WebSocket.OPEN;
    session.pane.classList.toggle("is-attached", session.attached);
    session.control.textContent = session.attached ? "Detach" : "Attach";
    session.control.setAttribute("aria-pressed", String(session.attached));
    session.control.disabled = session.exited || !connected || (!session.attached && !session.available);
    if (session.error) session.status.textContent = session.error;
    else if (session.exited) session.status.textContent = session.exitCode === null ? "Exited" : `Exited (${session.exitCode})`;
    else if (session.attached) session.status.textContent = "Attached · keyboard active";
    else if (connected && !session.available) session.status.textContent = "Read only · control in use";
    else if (connected) session.status.textContent = "Read only";
  }

  function scheduleTerminalReconnect(session) {
    if (document.hidden || session.disposed || session.exited || session.reconnectTimer) return;
    const delay = Math.min(8000, 500 * (2 ** Math.min(session.reconnectAttempt, 4)));
    session.reconnectAttempt += 1;
    session.status.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s…`;
    session.reconnectTimer = window.setTimeout(async () => {
      session.reconnectTimer = null;
      if (document.hidden || session.disposed || session.exited) return;
      await loadConfig({ announceError: false, clearOnError: false });
      connectTerminal(session);
    }, delay);
  }

  function scheduleTerminalResize(session) {
    if (!session.attached || session.disposed || !session.pane.isConnected || document.hidden) return;
    if (session.resizeTimer) clearTimeout(session.resizeTimer);
    if (session.resizeFrame) cancelAnimationFrame(session.resizeFrame);
    session.resizeTimer = window.setTimeout(() => {
      session.resizeTimer = null;
      session.resizeFrame = requestAnimationFrame(() => {
        session.resizeFrame = null;
        resizeTerminalToHost(session);
      });
    }, 80);
  }

  function resizeTerminalToHost(session) {
    if (!session.attached || !session.terminal || !session.scroll.clientWidth || !session.scroll.clientHeight) return;
    const metrics = terminalCellMetrics(session);
    if (!metrics) return;
    const width = session.scroll.clientWidth;
    const height = session.scroll.clientHeight;
    session.host.style.width = `${width}px`;
    session.host.style.height = `${height}px`;
    session.scroll.scrollLeft = 0;
    session.scroll.scrollTop = 0;
    const cols = Math.max(40, Math.min(300, Math.floor((width - metrics.scrollbarWidth) / metrics.cellWidth)));
    const rows = Math.max(10, Math.min(100, Math.floor(height / metrics.cellHeight)));
    const size = `${cols}x${rows}`;
    if (session.terminal.cols !== cols || session.terminal.rows !== rows) session.terminal.resize(cols, rows);
    if (session.lastSentSize === size) return;
    session.lastSentSize = size;
    sendTerminalMessage(session, { type: "resize", cols, rows });
  }

  function terminalCellMetrics(session) {
    if (!session.terminal || !session.terminal.cols || !session.terminal.rows) return null;
    const screen = $(".xterm-screen", session.host);
    if (!screen) return null;
    const bounds = screen.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const viewport = $(".xterm-viewport", session.host);
    return {
      cellWidth: bounds.width / session.terminal.cols,
      cellHeight: bounds.height / session.terminal.rows,
      scrollbarWidth: viewport ? Math.max(0, viewport.offsetWidth - viewport.clientWidth) : 0,
      screenWidth: bounds.width,
      screenHeight: bounds.height,
    };
  }

  function scheduleReadonlyTerminalLayout(session) {
    if (session.attached || session.disposed || session.layoutFrame || !session.pane.isConnected || document.hidden) return;
    session.layoutFrame = requestAnimationFrame(() => {
      session.layoutFrame = null;
      layoutReadonlyTerminal(session);
    });
  }

  function layoutReadonlyTerminal(session) {
    if (session.attached || session.disposed || !session.terminal || document.hidden) return;
    const metrics = terminalCellMetrics(session);
    if (!metrics) return;
    session.host.style.width = `${Math.max(session.scroll.clientWidth, Math.ceil(metrics.screenWidth + metrics.scrollbarWidth))}px`;
    session.host.style.height = `${Math.max(session.scroll.clientHeight, Math.ceil(metrics.screenHeight))}px`;
  }

  function clampDimension(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : 0;
  }

  function disposeTerminalSession(id) {
    const session = state.terminalSessions.get(id);
    if (!session) return;
    session.disposed = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.resizeTimer) clearTimeout(session.resizeTimer);
    if (session.resizeFrame) cancelAnimationFrame(session.resizeFrame);
    if (session.layoutFrame) cancelAnimationFrame(session.layoutFrame);
    if (session.attached) sendTerminalMessage(session, { type: "detach" });
    if (session.socket) {
      session.socket.onclose = null;
      session.socket.close();
    }
    if (session.observer) session.observer.disconnect();
    if (session.inputDisposable) session.inputDisposable.dispose();
    for (const disposable of session.parserDisposables) disposable.dispose();
    if (session.terminal) session.terminal.dispose();
    session.host.replaceChildren();
    state.terminalSessions.delete(id);
  }

  function renderCharts(run) {
    const metrics = run.metrics || {};
    const series = Array.isArray(metrics.series) ? metrics.series : [];
    const panel = detailPanel("Activity & concurrency", series.length ? `${series.length} samples` : "no samples");
    if (metrics.available === false || !series.length) {
      panel.append(stateCard("∿", "Metrics not available", ACTIVE_STATUSES.has(run.status) ? "Activity samples will appear while the run progresses." : "This run did not publish a metric series."));
      return panel;
    }
    const charts = node("div", "charts");
    charts.append(
      chartBlock(run.id, "activity", "Work activity", `Steps ${metric(metrics, "steps")} · JEV ${metric(metrics, "jevCalls")} · Synth ${metric(metrics, "synthCalls")}`, [["steps", "#ad7cff"], ["jevCalls", "#52d29b"], ["synthCalls", "#ffcc66"]]),
      chartBlock(run.id, "parallel", "Concurrency", `Peak ${metric(metrics, "peakParallelism")} · Avg ${decimalMetric(metrics, "avgParallelism")}`, [["active", "#58a6ff"]]),
    );
    panel.append(charts);
    return panel;
  }

  function chartBlock(runId, kind, label, summary, legendItems) {
    const wrap = node("div", "chart-wrap");
    const heading = node("div", "chart-label");
    append(heading, node("span", "", label), node("b", "", summary));
    const canvas = node("canvas", "chart");
    canvas.dataset.chartRun = runId;
    canvas.dataset.chartKind = kind;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${label} over time`);
    const legend = node("div", "chart-legend");
    for (const [key, color] of legendItems) {
      const labelNode = node("span", "", key === "jevCalls" ? "JEV calls" : key === "synthCalls" ? "Synth calls" : key);
      labelNode.style.setProperty("--legend-color", color);
      legend.append(labelNode);
    }
    append(wrap, heading, canvas, legend);
    return wrap;
  }

  function drawCharts() {
    for (const canvas of elements.runList.querySelectorAll("canvas[data-chart-run]")) {
      const run = state.details.get(canvas.dataset.chartRun) || state.runs.find((item) => item.id === canvas.dataset.chartRun);
      const series = run && run.metrics && Array.isArray(run.metrics.series) ? run.metrics.series : [];
      if (!series.length) continue;
      const keys = canvas.dataset.chartKind === "parallel" ? [["active", "#58a6ff"]] : [["steps", "#ad7cff"], ["jevCalls", "#52d29b"], ["synthCalls", "#ffcc66"]];
      drawLineChart(canvas, series, keys);
    }
  }

  function drawLineChart(canvas, series, keys) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const pad = { top: 10 * ratio, right: 9 * ratio, bottom: 16 * ratio, left: 24 * ratio };
    const chartWidth = width - pad.left - pad.right;
    const chartHeight = height - pad.top - pad.bottom;
    const maxima = keys.flatMap(([key]) => series.map((point) => finiteNumber(point[key], 0)));
    const max = Math.max(1, ...maxima);
    context.strokeStyle = "#292f34";
    context.lineWidth = ratio;
    context.fillStyle = "#69727a";
    context.font = `${8 * ratio}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
    context.textAlign = "right";
    for (let line = 0; line <= 2; line += 1) {
      const y = pad.top + chartHeight * (line / 2);
      context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
      context.fillText(String(Math.round(max * (1 - line / 2))), pad.left - 4 * ratio, y + 3 * ratio);
    }
    for (const [key, color] of keys) {
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 1.5 * ratio;
      context.lineJoin = "round";
      series.forEach((point, index) => {
        const x = pad.left + (series.length === 1 ? chartWidth : chartWidth * index / (series.length - 1));
        const y = pad.top + chartHeight - (finiteNumber(point[key], 0) / max) * chartHeight;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
    }
    context.textAlign = "left";
    const first = series[0] && series[0].time;
    const last = series[series.length - 1] && series[series.length - 1].time;
    context.fillStyle = "#69727a";
    context.fillText(shortTime(first), pad.left, height - 4 * ratio);
    const lastText = shortTime(last);
    context.textAlign = "right";
    context.fillText(lastText, width - pad.right, height - 4 * ratio);
  }

  function renderProvenance(run) {
    const panel = detailPanel("Provenance", run.source && run.source.mode ? run.source.mode : "source");
    const source = run.source || {};
    panel.append(infoList([
      ["Mode", source.mode || run.sourceMode || "—"],
      ["Model", run.model || "Agent default"],
      ["Thinking effort", run.effort || "Agent default"],
      ["Branch", source.branch || "detached"],
      ["Revision", source.revision || "—"],
      ["Working tree", source.dirty === true ? "dirty" : source.dirty === false ? "clean" : "—", source.dirty === true ? "dirty" : source.dirty === false ? "clean" : ""],
      ["Code hash", source.codeHash || "—"],
      ["Started", formatDateTime(run.startedAt)],
      ["Last event", formatDateTime(run.metrics && run.metrics.lastEventAt)],
    ]));
    return panel;
  }

  function renderArtifacts(run) {
    const files = state.artifacts.get(run.id);
    const error = state.artifactErrors.get(run.id);
    const panel = detailPanel("Deliverables", files ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "artifacts");
    if (error) {
      panel.append(node("p", "artifact-state artifact-error", error));
      return panel;
    }
    if (files === undefined) {
      panel.append(node("p", "artifact-state", "Loading deliverables…"));
      return panel;
    }
    if (!files.length) {
      panel.append(node("p", "artifact-state", "No deliverables were reported."));
      return panel;
    }
    const list = node("ul", "artifact-list");
    files.forEach((file, index) => {
      const item = node("li");
      const link = node("a", "artifact-link", file && file.path ? String(file.path) : "Unnamed file");
      const path = file && file.path ? String(file.path) : "";
      link.href = `/api/runs/${encodeURIComponent(run.id)}/artifact?path=${encodeURIComponent(path)}`;
      link.setAttribute("download", "");
      link.dataset.focusKey = `artifact:${run.id}:${index}`;
      const size = node("span", "", formatBytes(file && file.bytes));
      append(item, link, size);
      list.append(item);
    });
    panel.append(list);
    return panel;
  }

  function renderGrading(run) {
    const grading = run.grading || { status: "ungraded" };
    const attempts = Array.isArray(grading.attempts) ? grading.attempts : [];
    const panel = detailPanel("Grading", grading.status || "ungraded");
    const rows = [["Status", grading.status || "ungraded"], ["Attempts", String(attempts.length)]];
    panel.append(infoList(rows));
    if ((grading.status && grading.status !== "ungraded") || grading.report) {
      const links = node("div", "panel-links");
      const report = node("a", "button button-quiet", "View JSON report");
      report.href = `/api/runs/${encodeURIComponent(run.id)}/report`;
      report.target = "_blank";
      report.rel = "noopener";
      report.dataset.focusKey = `report:${run.id}`;
      links.append(report);
      panel.append(links);
    }
    return panel;
  }

  function detailPanel(title, meta) {
    const panel = node("section", "detail-panel");
    const header = node("header", "detail-panel-header");
    const tools = node("div", "panel-header-tools");
    tools.append(node("span", "", meta));
    append(header, node("h3", "", title), tools);
    panel.append(header);
    return panel;
  }

  function infoList(rows) {
    const list = node("dl", "info-list");
    for (const [label, value, className] of rows) {
      const row = node("div", "info-row");
      const description = node("dd", className || "", value === undefined || value === null || value === "" ? "—" : String(value));
      append(row, node("dt", "", label), description);
      list.append(row);
    }
    return list;
  }

  async function toggleRun(id) {
    captureViewState();
    if (state.expanded.has(id)) {
      if (state.maximizedOutput === id) state.maximizedOutput = "";
      state.expanded.delete(id);
      renderRuns();
      return;
    }
    state.expanded.add(id);
    renderRuns();
    await refreshOneRun(id);
  }

  async function refreshOneRun(id) {
    const [runResult, outputResult, artifactsResult] = await Promise.allSettled([
      api(`/api/runs/${encodeURIComponent(id)}`),
      api(`/api/runs/${encodeURIComponent(id)}/output`),
      api(`/api/runs/${encodeURIComponent(id)}/artifacts`),
    ]);
    if (runResult.status === "fulfilled" && runResult.value) state.details.set(id, runResult.value);
    if (outputResult.status === "fulfilled") {
      const output = outputResult.value;
      state.outputs.set(id, output && typeof output.text === "string" ? output.text : "");
      state.outputErrors.delete(id);
    } else {
      state.outputErrors.set(id, normalizeError(outputResult.reason, "Could not load terminal output."));
    }
    if (artifactsResult.status === "fulfilled") {
      const payload = artifactsResult.value;
      state.artifacts.set(id, payload && Array.isArray(payload.files) ? payload.files : []);
      state.artifactErrors.delete(id);
    } else {
      state.artifactErrors.set(id, normalizeError(artifactsResult.reason, "Could not load deliverables."));
    }
    captureViewState();
    renderRuns();
  }

  async function mutateRun(id, action, successMessage, body) {
    try {
      const options = { method: "POST", mutation: true };
      if (body !== undefined) options.body = JSON.stringify(body);
      const run = await api(`/api/runs/${encodeURIComponent(id)}/${action}`, options);
      if (run && run.id) state.details.set(id, run);
      showToast(successMessage);
      await refreshState({ announceError: true });
    } catch (error) {
      showToast(normalizeError(error), true);
    }
  }

  function openDialog() {
    elements.formError.hidden = true;
    if (!elements.dialog.open) elements.dialog.showModal();
    void loadModels();
    requestAnimationFrame(() => elements.taskSelect.focus());
  }

  function closeDialog() {
    if (elements.dialog.open) elements.dialog.close();
  }

  async function loadModels(reset = false) {
    const request = ++state.modelRequest;
    const agent = elements.form.elements.agent.value;
    const previous = reset ? "" : elements.model.value;
    const previousEffort = reset ? "" : elements.effort.value;
    state.models = [];
    const fallback = node("option", "", "Agent default"); fallback.value = "";
    elements.model.replaceChildren(fallback);
    elements.model.disabled = true;
    elements.modelNotice.textContent = "Loading available models…";
    updateEfforts();
    try {
      const catalog = await api(`/api/models?agent=${encodeURIComponent(agent)}`);
      if (request !== state.modelRequest) return;
      state.models = Array.isArray(catalog.models) ? catalog.models : [];
      for (const model of state.models) {
        const option = node("option", "", model.name || model.id); option.value = model.id;
        elements.model.append(option);
      }
      if (state.models.some(model => model.id === previous)) elements.model.value = previous;
      elements.modelNotice.textContent = catalog.notice || "";
      updateEfforts(previousEffort);
    } catch (error) {
      if (request === state.modelRequest) elements.modelNotice.textContent = normalizeError(error);
    } finally { if (request === state.modelRequest) elements.model.disabled = false; }
  }

  function updateEfforts(previous = "") {
    const model = state.models.find(model => model.id === elements.model.value);
    const efforts = model && Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
    const fallback = node("option", "", "Agent default"); fallback.value = "";
    elements.effort.replaceChildren(fallback);
    const names = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
    for (const effort of efforts) {
      const option = node("option", "", names[effort] || effort); option.value = effort; elements.effort.append(option);
    }
    if (efforts.includes(previous)) elements.effort.value = previous;
    elements.effort.disabled = efforts.length === 0;
    elements.effortNotice.textContent = !model ? "Choose a model to see available effort levels." : model.reasoningEfforts === undefined ? "Effort metadata unavailable; using the agent default." : !efforts.length ? "This model has no adjustable thinking effort." : "Only this model’s supported levels are shown.";
  }

  function updateSourceMode() {
    const mode = elements.form.elements.sourceMode.value;
    elements.commitField.hidden = mode !== "commit";
    elements.commit.required = mode === "commit";
    if (mode !== "commit") elements.commit.setCustomValidity("");
  }

  function applyRecordingPreset() {
    const [width, height, columns, rows] = elements.recordingPreset.value.split(",");
    elements.recordingWidth.value = width;
    elements.recordingHeight.value = height;
    elements.recordingColumns.value = columns;
    elements.recordingRows.value = rows;
  }

  function updateRecording() {
    const native = elements.executionMode.value === "terminal";
    if (native) elements.recordingEnabled.checked = false;
    elements.recordingEnabled.disabled = native;
    elements.recordingNotice.textContent = native
      ? "Recording currently supports headless transcripts only."
      : "Opt in to an MP4 export of the captured headless transcript.";
    elements.recordingOptions.hidden = native || !elements.recordingEnabled.checked;
    elements.recordingEnabled.closest(".switch").classList.toggle("is-checked", elements.recordingEnabled.checked);
    for (const input of [elements.recordingWidth, elements.recordingHeight, elements.recordingColumns, elements.recordingRows]) input.disabled = native || !elements.recordingEnabled.checked;
    if (elements.recordingEnabled.checked && !elements.recordingWidth.value) applyRecordingPreset();
  }

  function updateExecutionMode() {
    const native = elements.executionMode.value === "terminal";
    elements.executionModeNotice.textContent = native
      ? "Starts the task immediately, then stays alive for follow-up messages until it exits or you cancel it."
      : "Runs non-interactively and keeps a captured transcript in Logs.";
    updateRecording();
  }

  async function submitRun(event) {
    event.preventDefault();
    elements.formError.hidden = true;
    if (!elements.form.reportValidity()) return;
    const sourceMode = elements.form.elements.sourceMode.value;
    const agent = elements.form.elements.agent.value;
    const executionMode = elements.executionMode.value === "headless" ? "headless" : "terminal";
    const payload = { task: elements.taskSelect.value, agent, sourceMode, executionMode };
    const model = elements.model.value.trim();
    const timeout = elements.timeout.value.trim();
    const commit = elements.commit.value.trim();
    if (model) payload.model = model;
    if (!elements.effort.disabled && elements.effort.value) payload.effort = elements.effort.value;
    if (timeout) payload.timeoutSeconds = Number(timeout);
    if (sourceMode === "commit") payload.commit = commit;
    if (elements.recordingEnabled.checked) {
      payload.recording = {
        width: Number(elements.recordingWidth.value),
        height: Number(elements.recordingHeight.value),
        columns: Number(elements.recordingColumns.value),
        rows: Number(elements.recordingRows.value),
      };
    }
    elements.submitRun.disabled = true;
    try {
      const response = await api("/api/runs", { method: "POST", mutation: true, body: JSON.stringify(payload) });
      if (!response || !response.id) throw new Error("The server did not return a run ID.");
      state.expanded.add(response.id);
      closeDialog();
      showToast(`Run ${response.id} started.`);
      await refreshState({ announceError: true });
    } catch (error) {
      elements.formError.textContent = normalizeError(error, "Could not start the run.");
      elements.formError.hidden = false;
    } finally {
      elements.submitRun.disabled = false;
    }
  }

  function showToast(message, isError = false) {
    const toast = node("div", `toast${isError ? " is-error" : ""}`, message);
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4800);
  }

  function taskTitle(id) {
    const task = state.tasks.find((item) => item.id === id);
    return task && task.title ? task.title : id || "Unknown task";
  }

  function statusLabel(status) {
    return String(status || "unknown").replaceAll("_", " ");
  }

  function shortRevision(revision) {
    const value = String(revision);
    return value.length > 10 ? value.slice(0, 10) : value;
  }

  function safeId(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
  }

  function finiteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function metric(metrics, key) {
    const value = finiteNumber(metrics && metrics[key]);
    return value === null ? "—" : new Intl.NumberFormat().format(value);
  }

  function decimalMetric(metrics, key) {
    const value = finiteNumber(metrics && metrics[key]);
    return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function formatBytes(value) {
    const bytes = finiteNumber(value);
    if (bytes === null || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toLocaleString(undefined, { maximumFractionDigits: size >= 10 ? 0 : 1 })} ${units[unit]}`;
  }

  function graphMetric(metrics) {
    const completed = finiteNumber(metrics && metrics.graphsCompleted);
    const started = finiteNumber(metrics && metrics.graphsStarted);
    const failed = finiteNumber(metrics && metrics.graphsFailed, 0);
    if (completed === null && started === null) return "—";
    const base = `${completed ?? 0}/${started ?? 0}`;
    return failed ? `${base} · ${failed} failed` : base;
  }

  function loopMetric(metrics) {
    const repeats = finiteNumber(metrics && metrics.repeatIterations);
    const items = finiteNumber(metrics && metrics.foreachItems);
    if (repeats === null && items === null) return "—";
    return `${repeats ?? 0}r · ${items ?? 0}i`;
  }

  function runElapsed(run) {
    const explicit = finiteNumber(run.elapsedMs);
    if (explicit !== null) return explicit;
    const start = Date.parse(run.startedAt || "");
    if (!Number.isFinite(start)) return null;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    return Number.isFinite(end) ? Math.max(0, end - start) : null;
  }

  function formatDuration(milliseconds, live = false) {
    const value = finiteNumber(milliseconds);
    if (value === null) return live ? "Starting…" : "—";
    if (value < 1000) return `${Math.round(value)}ms`;
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  function parseDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function formatDate(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
  }

  function formatTime(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date) : "";
  }

  function formatDateTime(value) {
    const date = parseDate(value);
    return date ? `${formatDate(value)} ${formatTime(value)}` : "—";
  }

  function shortTime(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date) : "";
  }

  elements.search.addEventListener("input", () => { captureScrollPositions(); renderRuns(); });
  elements.statusFilter.addEventListener("change", () => { captureScrollPositions(); renderRuns(); });
  elements.agentFilter.addEventListener("change", () => { captureScrollPositions(); renderRuns(); });
  elements.newRunButton.addEventListener("click", openDialog);
  elements.closeDialog.addEventListener("click", closeDialog);
  elements.cancelDialog.addEventListener("click", closeDialog);
  elements.taskSelect.addEventListener("change", updateTaskDescription);
  elements.form.addEventListener("submit", submitRun);
  elements.model.addEventListener("change", () => updateEfforts());
  for (const input of elements.form.querySelectorAll('input[name="agent"]')) input.addEventListener("change", () => loadModels(true));
  for (const input of elements.form.querySelectorAll('input[name="sourceMode"]')) input.addEventListener("change", updateSourceMode);
  elements.recordingEnabled.addEventListener("change", updateRecording);
  elements.recordingPreset.addEventListener("change", applyRecordingPreset);
  elements.executionMode.addEventListener("change", updateExecutionMode);
  elements.dialog.addEventListener("click", (event) => {
    const rect = elements.dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const terminalPane = target && target.closest ? target.closest(".native-terminal-pane") : null;
    const terminalSession = terminalPane ? state.terminalSessions.get(terminalPane.dataset.terminalRun) : null;
    if (event.key === "Escape" && state.maximizedOutput && !(terminalSession && terminalSession.attached)) {
      event.preventDefault();
      captureViewState();
      state.maximizedOutput = "";
      renderRuns();
      return;
    }
    if (event.key === "/" && !typing && !elements.dialog.open) {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key.toLowerCase() === "n" && !typing && !elements.dialog.open) {
      event.preventDefault();
      openDialog();
    }
  });
  document.addEventListener("visibilitychange", () => {
    schedulePolling();
    if (document.hidden) {
      for (const id of [...state.terminalSessions.keys()]) disposeTerminalSession(id);
      return;
    }
    renderRuns();
    refreshState();
  });
  window.addEventListener("resize", () => requestAnimationFrame(drawCharts));
  window.addEventListener("beforeunload", () => {
    for (const id of [...state.terminalSessions.keys()]) disposeTerminalSession(id);
  });

  applyRecordingPreset();
  updateExecutionMode();
  updateSourceMode();
  Promise.all([loadConfig(), refreshState({ announceError: false })]).finally(schedulePolling);
})();
