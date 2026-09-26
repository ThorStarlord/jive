import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./runtime-contract.ts";
import { safeChildEnvironment } from "./security.ts";

export interface CommandOptions {
  script: string; cwd: string; env?: Record<string, string>; stdin?: string;
  timeoutMs?: number; signal?: AbortSignal; outputPrefix?: string;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export interface CommandResult {
  exitCode: number; stdout: string; stderr: string;
  stdoutPath?: string; stderrPath?: string; stdoutTruncated: boolean; stderrTruncated: boolean;
}
export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  // The stdin payload is also saved to a file so scripts that consume stdin for their own source
  // (a python3 - heredoc) can still read the node input through $JIVE_STDIN.
  const stdinEnv: Record<string, string> = {};
  if (options.stdin !== undefined && options.outputPrefix) {
    stdinEnv.JIVE_STDIN = `${options.outputPrefix}.stdin`;
    await writeFile(stdinEnv.JIVE_STDIN, options.stdin);
  }
  const child = spawn("bash", ["-c", options.script], { cwd: options.cwd, env: { ...safeChildEnvironment(), ...stdinEnv, ...options.env }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const files = options.outputPrefix ? { stdout: createWriteStream(`${options.outputPrefix}.stdout`), stderr: createWriteStream(`${options.outputPrefix}.stderr`) } : undefined;
  const capture = { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  const cap = 2 * 1024 * 1024;
  let stopped = false, timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch {}
  };
  const stop = () => { stopped = true; kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 400); };
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      files?.[stream].write(chunk);
      const available = cap - capture[stream].length;
      if (available > 0) capture[stream] += chunk.slice(0, available);
      if (chunk.length > available) capture[`${stream}Truncated`] = true;
      options.onOutput?.(stream, chunk);
    });
  }
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin ?? "");
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 128));
    });
    const result = { exitCode: code, ...capture, ...(options.outputPrefix ? { stdoutPath: `${options.outputPrefix}.stdout`, stderrPath: `${options.outputPrefix}.stderr` } : {}) };
    if (timedOut || stopped) throw Object.assign(new Error(timedOut ? `Command exceeded ${options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms timeout` : "Command interrupted"), { commandResult: result });
    return result;
  } finally {
    clearTimeout(timer); if (force) { kill("SIGKILL"); clearTimeout(force); }
    options.signal?.removeEventListener("abort", stop);
    if (files) { files.stdout.end(); files.stderr.end(); await Promise.all([finished(files.stdout), finished(files.stderr)]); }
  }
}
