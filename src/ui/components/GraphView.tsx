import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FileChangeSummary } from "../../core/file-changes.ts";
import { BUILDING_LABEL } from "../../core/graph-stream.ts";
import type { GraphModel, GraphNode } from "../graph/model.ts";
import { countStatuses, statusTone, type StatusTone } from "../graph/model.ts";
import { edgeCellState, formatDuration, groupSummary, layoutGraph, loopGlyph, revealActive, revealProgress, statusGlyph, sweepActive, type LaneCell, type LayoutRow } from "../graph/layout.ts";
import { dimHex, mixHex, palette } from "../theme.ts";

const TICK_MS = 80;
const BUILD_TICK_MS = 240;
const BUILD_DOTS = ["   ", ".  ", ".. ", "..."];
/** A graph under construction has no name yet, so the header stands one of these in its place. */
export const BUILD_WORDS = ["Assembling", "Conducting", "Composing", "Arranging", "Wiring", "Plotting", "Weaving"];
/** Graphs of this many nodes or fewer are read directly; above it the progress counter earns its place. */
const COUNTER_MIN_NODES = 5;
/** Beyond this the file list is a wall of text, and the badge's total covers the rest. */
const MAX_CHANGE_LINES = 6;

export function toneColor(tone: StatusTone, type?: GraphNode["type"]): string {
  switch (tone) {
    case "done":
      return type === "jev" ? palette.purple : palette.green;
    case "warn":
      return palette.yellow;
    case "blocked":
      return palette.grey;
    case "running":
      return palette.accent;
    case "building":
      return palette.textFaint;
    default:
      return palette.textDim;
  }
}

function cellColor(graph: GraphModel, cell: LaneCell, now: number, nodeColor: string): string {
  if (cell.kind === "node") return nodeColor;
  if (cell.kind === "empty") return palette.bg;
  if (cell.kind === "loop") {
    // The loop-back lane follows its group: lit while the loop runs, settled when it is over.
    const group = cell.from ? graph.nodes[cell.from] : undefined;
    return group ? dimHex(toneColor(statusTone(group.status)), 0.25) : palette.greyDim;
  }
  const state = edgeCellState(graph, cell, now);
  if (state === "ready") return palette.green;
  if (state === "sweeping") return dimHex(palette.green, 0.65);
  return palette.greyDim;
}

function truncate(s: string, max: number): string {
  if (max <= 1) return "";
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
}

function graphStatusColor(status: string | undefined): string {
  switch (status) {
    case "done":
      return palette.green;
    case "partial":
    case "yielded":
      return palette.yellow;
    case "cancelled":
      return palette.grey;
    default:
      return palette.accent;
  }
}

/** Construction remains visible when committed nodes already execute. */
export function phaseCaption(graph: GraphModel): { text: string; color: string } | null {
  if (graph.building) return null;
  switch (graph.phase) {
    case "building":
      return null;
    case "ready":
      return { text: "ready to run", color: palette.textDim };
    case "interrupted":
      return { text: "assembly interrupted", color: palette.yellow };
    case "failed":
      return { text: graph.buildError ? `assembly failed · ${graph.buildError}` : "assembly failed", color: palette.yellow };
    default:
      return null;
  }
}

/**
 * The stand-in header for a graph that has not streamed its own label yet. The word is drawn
 * from the graph's own id, so one build keeps the word it opened with however long it runs;
 * only the dots move, and they run off the clock rather than the tick, so they hold their pace
 * whatever cadence the surrounding animation is running at.
 */
export function buildingTitle(graphId: string, now: number): string {
  let hash = 0;
  for (let i = 0; i < graphId.length; i++) hash = (hash * 31 + graphId.charCodeAt(i)) >>> 0;
  return BUILD_WORDS[hash % BUILD_WORDS.length]! + BUILD_DOTS[Math.floor(now / BUILD_TICK_MS) % BUILD_DOTS.length];
}

/** Header badge: how many files the run changed and by how much, e.g. "✎ 3 files +42 −7". */
export function changeBadge(changes: FileChangeSummary | undefined, withCounts = true): string | null {
  if (!changes || changes.total === 0) return null;
  const counts = withCounts
    ? [changes.added ? `+${changes.added}` : "", changes.removed ? `−${changes.removed}` : ""].filter(Boolean).join(" ")
    : "";
  return `✎ ${changes.total} file${changes.total === 1 ? "" : "s"}${counts ? ` ${counts}` : ""}`;
}

/** The badge in whatever form fits the room left on a title line, or nothing. */
export function fittedBadge(changes: FileChangeSummary | undefined, room: number): string | null {
  const full = changeBadge(changes);
  if (!full) return null;
  if (full.length <= room) return full;
  const short = changeBadge(changes, false)!;
  return short.length <= room ? short : null;
}

function changeEntry(file: FileChangeSummary["files"][number]): string {
  const counts = [file.added ? `+${file.added}` : "", file.removed ? `−${file.removed}` : ""].filter(Boolean).join(" ");
  if (counts) return `${file.path} ${counts}`;
  return file.kind === "deleted" ? `${file.path} deleted` : file.path;
}

/** A path too long for the line loses its leading directories: the name and counts say more. */
function fittedEntry(file: FileChangeSummary["files"][number], width: number): string {
  const entry = changeEntry(file);
  if (entry.length <= width) return entry;
  const counts = entry.slice(file.path.length);
  const room = Math.max(1, width - counts.length);
  return (file.path.length <= room ? file.path : "…" + file.path.slice(file.path.length - room + 1)) + counts;
}

/**
 * One line per changed file, closing with how many were left out. The badge already
 * carries the total, so a shortened list still tells the whole count.
 */
export function changeLines(changes: FileChangeSummary, width: number, max = MAX_CHANGE_LINES): string[] {
  const shown = changes.files.slice(0, Math.max(1, max));
  const lines = shown.map((file) => fittedEntry(file, width));
  const rest = changes.total - shown.length;
  if (rest > 0) lines.push(`+${rest} more`);
  return lines;
}

export interface GraphViewProps {
  graph: GraphModel;
  width: number;
  expanded: ReadonlySet<string>;
  folded?: ReadonlySet<string>;
  /** Row index highlighted when this graph has keyboard focus, else -1. */
  selectedRow: number;
  focused: boolean;
  onCopyFailure?: (text: string) => void;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Full text copied by the failed-call button: the error plus any recorded response. */
export function failureCopyText(node: GraphNode): string {
  const response = node.result?.output !== undefined
    ? printable(node.result.output)
    : node.synthResponses.length > 0
      ? printable(node.synthResponses[node.synthResponses.length - 1]!.data)
      : node.jevResponses.length > 0
        ? printable(node.jevResponses[node.jevResponses.length - 1]!.data)
        : node.output.trim();
  return [node.error, response].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function GraphView(props: GraphViewProps) {
  const { graph, width, expanded, folded } = props;
  const layout = useMemo(() => layoutGraph(graph, { expanded, folded }), [graph, expanded, folded]);
  const counts = countStatuses(graph);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const building = graph.building ?? graph.phase === "building";
  const animating = counts.running > 0 || sweepActive(graph, layout, now) || revealActive(graph, now);
  useEffect(() => {
    if (!animating && !building) return;
    const id = setInterval(
      () => {
        setNow(Date.now());
        setTick((t) => t + 1);
      },
      animating ? TICK_MS : BUILD_TICK_MS,
    );
    return () => clearInterval(id);
  }, [animating, building]);
  useEffect(() => {
    setNow(Date.now());
  }, [graph.lastSequence]);

  const narrow = width < 70;
  const gutterWidth = layout.laneCount * 2;
  const labelBudget = Math.max(6, width - gutterWidth - (narrow ? 14 : 34));
  const caption = phaseCaption(graph);
  // A handful of rows counts itself at a glance, so the progress counter — this graph's own
  // node executions, nothing from any other call — only appears once the graph outgrows that.
  const counted = counts.total > COUNTER_MIN_NODES;
  const summary = [
    counted ? (counts.total > counts.building ? `${counts.done}/${counts.total} done` : `${counts.total} nodes`) : "",
    counts.building && counts.total > counts.building ? `${counts.building} drafted` : "",
    counts.running ? `${counts.running} running` : "",
    counts.warn ? `${counts.warn} stopped` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
    layout.hidden ? `${layout.hidden} folded` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const graphDuration = graph.startedAt !== undefined ? formatDuration((graph.finishedAt ?? now) - graph.startedAt) : "";
  // Until the stream names the graph, its header cycles a word rather than sitting on a placeholder.
  const heading = building && graph.label === BUILDING_LABEL ? buildingTitle(graph.id, now) : graph.label;
  const title = truncate(heading, Math.max(8, width - 40));
  // Everything the title line carries after the title, measured so the badge can be the
  // first thing to go when the line is full: the files are named on the line below anyway.
  const tail = [
    caption ? ` · ${caption.text}` : "",
    summary ? ` · ${summary}` : "",
    graph.status ? ` · ${graph.status}` : "",
    graphDuration && !narrow ? ` · ${graphDuration}` : "",
  ].join("");
  const badge = fittedBadge(graph.changes, width - 7 - title.length - tail.length);
  // A call that turned into one node needs no title above it: the row carries the title,
  // and the counts a header would add ("1/1 done") only repeat the row's own status.
  const only = layout.rows.length === 1 && !layout.rows[0]!.group && !caption && !building ? layout.rows[0]! : null;
  // The same measurement for that row, which carries the title itself.
  const soloTitle = only ? truncate(heading || only.node.label, labelBudget) : "";
  const soloBadge = only ? fittedBadge(graph.changes, width - 7 - soloTitle.length) : null;
  const reasonShownOnNode = graph.reason !== undefined && Object.values(graph.nodes).some((node) => node.error === graph.reason);

  return (
    <box flexDirection="column" width="100%" paddingLeft={1} border={["left"]} borderStyle="single" borderColor={props.focused ? palette.accent : palette.borderSoft}>
      {only ? (
        <GraphRow
          graph={graph}
          row={only}
          now={now}
          tick={tick}
          selected={props.focused && props.selectedRow === 0}
          narrow={narrow}
          labelBudget={labelBudget}
          width={width - 2}
          onCopyFailure={props.onCopyFailure}
          title={soloTitle}
          trailing={
            <>
              {soloBadge ? (
                <>
                  <span fg={palette.textFaint}> · </span>
                  <span fg={palette.textDim}>{soloBadge}</span>
                </>
              ) : null}
            </>
          }
        />
      ) : (
      <text wrapMode="none">
        <span fg={props.focused ? palette.accent : building ? palette.textDim : palette.text}>{props.focused ? "◆ " : building ? "◌ " : "◇ "}</span>
        <span fg={palette.text}>{title}</span>
        {caption ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={caption.color}>{caption.text}</span>
          </>
        ) : null}
        {summary ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={palette.textDim}>{summary}</span>
          </>
        ) : null}
        {graph.status ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={graphStatusColor(graph.status)}>{graph.status}</span>
          </>
        ) : null}
        {graphDuration && !narrow ? <span fg={palette.textFaint}> · {graphDuration}</span> : null}
        {badge ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={palette.textDim}>{badge}</span>
          </>
        ) : null}
      </text>
      )}
      {graph.reason && !reasonShownOnNode ? (
        <text fg={palette.yellow} wrapMode="word">
          {"  " + graph.reason}
        </text>
      ) : null}
      {/* One file per line: a row of paths separated by dots reads as prose, a column reads as a list. */}
      {graph.changes
        ? changeLines(graph.changes, Math.max(12, width - 5)).map((line, i) => (
            <text key={`change:${i}`} fg={palette.textFaint} wrapMode="none">
              {(i === 0 ? "  ✎ " : "    ") + line}
            </text>
          ))
        : null}
      {only ? null : layout.rows.map((row, i) => (
        <Fragment key={row.id}>
          {i > 0 && row.node.needs.includes(layout.rows[i-1]!.id) ? (
            <text wrapMode="none">
              {row.above.map((cell, column) => (
                <span key={column} fg={cellColor(graph,cell,now,palette.text)}>{cell.ch+" "}</span>
              ))}
            </text>
          ) : null}
          <GraphRow graph={graph} row={row} now={now} tick={tick} selected={props.focused && props.selectedRow === i} narrow={narrow} labelBudget={labelBudget} width={width - 2} onCopyFailure={props.onCopyFailure} />
        </Fragment>
      ))}
      {/* A graph still assembling says so in its header; only a settled, empty one needs a line of its own. */}
      {layout.rows.length === 0 && !building ? <text fg={palette.textFaint}>{"  waiting for nodes…"}</text> : null}
    </box>
  );
}

function GraphRow(props: {
  graph: GraphModel; row: LayoutRow; now: number; tick: number; selected: boolean; narrow: boolean; labelBudget: number;
  width: number;
  onCopyFailure?: (text: string) => void;
  /** Shown instead of the node's own label when the row stands in for the whole graph. */
  title?: string;
  trailing?: ReactNode;
}) {
  const { graph, row, now, tick } = props;
  const node = row.node;
  const bg = props.selected ? palette.surfaceRaised : undefined;
  const indent = "  ".repeat(row.depth);
  const caret = row.group ? (row.expanded ? "▾ " : "▸ ") : "";
  // A body row with no instance yet is a ghost: the loop's plan, not a node that exists.
  const ghost = !row.instance;
  const tone = statusTone(node.status);
  const color = ghost ? palette.textFaint : toneColor(tone, node.type);
  const reveal = revealProgress(node, now);
  // A previewed definition fades in: dim text and a faint leading dot until fully revealed.
  const revealing = reveal < 1;
  const glyph = ghost ? "◌" : revealing ? "·" : statusGlyph(node.status, tick);
  const labelColor = ghost ? palette.textDim : tone === "blocked" ? palette.grey : tone === "building" ? palette.textDim : palette.text;
  const fadedLabel = revealing ? mixHex(palette.bg, labelColor, 0.35 + 0.65 * reveal) : labelColor;
  const mark = row.group ? loopGlyph(node.type) + " " : "";
  const label = truncate(props.title ?? node.label, props.labelBudget - indent.length - caret.length - mark.length);
  const copied = node.status === "failed" ? failureCopyText(node) : "";
  const errorWidth = Math.min(30, Math.max(8, Math.floor(props.width * 0.38)));
  return (
    <box flexDirection="row" width="100%" minWidth={0} backgroundColor={bg}>
      <text wrapMode="none" flexGrow={1} minWidth={0} bg={bg}>
        {row.cells.map((cell, i) => (
          <span key={i} fg={cell.kind === "node" && revealing ? mixHex(palette.bg, color, 0.35 + 0.65 * reveal) : cellColor(graph, cell, now, color)}>
            {(cell.kind === "node" ? glyph : cell.ch) + (cell.hright ? "─" : " ")}
          </span>
        ))}
        <span fg={palette.textFaint}>{indent}</span>
        {caret ? <span fg={palette.accent}>{caret}</span> : null}
        {mark ? <span fg={ghost ? palette.textFaint : palette.accent}>{mark}</span> : null}
        <span fg={fadedLabel}>{label}</span>
        {row.group && !props.narrow ? <span fg={palette.textFaint}>  {groupSummary(row)}</span> : null}
        {node.artifact ? <span fg={palette.textFaint}> ⎘</span> : null}
        {props.trailing}
      </text>
      {node.error ? (
        <text wrapMode="none" maxWidth={errorWidth} fg={dimHex(palette.yellow, 0.3)} bg={bg}>
          {truncate(node.error.split("\n")[0] ?? "", errorWidth)}
        </text>
      ) : null}
      {copied && props.onCopyFailure ? (
        <text
          wrapMode="none"
          fg={palette.yellow}
          bg={props.selected ? palette.surface : palette.surfaceRaised}
          onMouseUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onCopyFailure?.(copied);
          }}
        >
          {" [⧉]"}
        </text>
      ) : null}
    </box>
  );
}
