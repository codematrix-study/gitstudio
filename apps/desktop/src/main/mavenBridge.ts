import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as l10n from "@vscode/l10n";
import type { MavenGoal, MavenLogChunk, MavenModule, MavenPaths, MavenTaskState } from "../shared/ipc";
import { discoverMavenModules } from "./mavenModules";
import { argsWithSettings, buildMavenArgs, mavenLaunch, selectablePaths } from "./mavenCommand";

// Node's spawn cannot execute a .cmd directly on Windows. cross-spawn resolves
// it and escapes each array argument for cmd.exe (including spaces and Chinese).
const crossSpawn = require("cross-spawn") as typeof spawn;

export class ConsoleDecoder {
  private pending = Buffer.alloc(0);

  decode(chunk: Buffer, final = false): string {
    this.pending = Buffer.concat([this.pending, chunk]);
    let output = "";
    let newline = this.pending.indexOf(10);
    while (newline >= 0) {
      output += this.decodeLine(this.pending.subarray(0, newline + 1));
      this.pending = this.pending.subarray(newline + 1);
      newline = this.pending.indexOf(10);
    }
    // ASCII is identical in UTF-8 and GB18030, so show it immediately. Hold
    // a non-ASCII partial line until its bytes are complete, then sniff that
    // line: plugins may mix UTF-8 and the Windows console code page.
    if (this.pending.length && (final || this.pending.length >= 8192 || this.pending.every((byte) => byte < 0x80))) {
      output += this.decodeLine(this.pending);
      this.pending = Buffer.alloc(0);
    }
    return output;
  }

  private decodeLine(bytes: Buffer): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // The Windows console and older Maven launchers can still emit GBK/GB18030.
      return new TextDecoder("gb18030").decode(bytes);
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function validate({ paths, wrapper }: MavenLaunchConfig): Promise<string | undefined> {
  if (wrapper && !(await isFile(wrapper))) return l10n.t("The Maven wrapper (mvnw) is missing");
  if (!wrapper && paths.mavenHome && !(await isFile(join(paths.mavenHome, "bin", process.platform === "win32" ? "mvn.cmd" : "mvn")))) {
    return l10n.t("Maven directory must contain bin/mvn (bin/mvn.cmd on Windows)");
  }
  if (paths.settings && !(await isFile(paths.settings))) return l10n.t("settings.xml file does not exist");
  if (paths.javaHome && !(await isFile(join(paths.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")))) {
    return l10n.t("JAVA_HOME must contain bin/java (bin/java.exe on Windows)");
  }
  return undefined;
}

function hasWarning(node: MavenModule): boolean {
  return !!node.warning || node.children.some(hasWarning);
}

/** The paths a run uses, plus the repository's mvnw when that is what runs. */
export interface MavenLaunchConfig {
  paths: MavenPaths;
  wrapper?: string;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  state: MavenTaskState;
  stopping: boolean;
}

export class MavenBridge {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Set<string>();
  private readonly testing = new Set<string>();
  private readonly states = new Map<string, MavenTaskState>();
  private readonly logs = new Map<string, MavenLogChunk[]>();
  private readonly logChars = new Map<string, number>();
  private nextId = 0;
  private nextLog = 0;

  constructor(
    /** The launch config for a repository, or the global one (no root). */
    private readonly settings: (root: string | undefined) => Promise<MavenLaunchConfig>,
    private readonly send: (event: "maven:log" | "maven:state", data: MavenLogChunk | MavenTaskState) => void,
  ) {}

  state(root: string): MavenTaskState | undefined { return this.states.get(resolve(root)); }
  logSnapshot(root: string): MavenLogChunk[] { return [...(this.logs.get(resolve(root)) || [])]; }

  /** `mvn -v` for a repository, or — without one — with the global settings. */
  async test(project: string | undefined): Promise<{ ok: boolean; output: string }> {
    const root = project ? resolve(project) : "";
    if (root && (this.running.has(root) || this.starting.has(root)) || this.testing.has(root)) {
      return { ok: false, output: l10n.t("A Maven task is already running") };
    }
    this.testing.add(root);
    try {
      const config = await this.settings(root || undefined);
      const problem = await validate(config);
      if (problem) return { ok: false, output: problem };
      const launch = mavenLaunch(config.paths, process.platform, process.env, config.wrapper);
      return await new Promise((done) => {
        const child = crossSpawn(launch.command, ["-v"], {
          cwd: root || homedir(), env: launch.env, windowsHide: true, detached: process.platform !== "win32",
        });
        const stdout = new ConsoleDecoder();
        const stderr = new ConsoleDecoder();
        let output = "";
        const append = (text: string): void => { output = (output + text).slice(-16000); };
        child.stdout.on("data", (b: Buffer) => append(stdout.decode(b)));
        child.stderr.on("data", (b: Buffer) => append(stderr.decode(b)));
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          done({ ok, output: output.trim() });
        };
        const timeout = setTimeout(() => { this.terminate(child); append(`\n${l10n.t("Maven version check timed out")}`); finish(false); }, 15000);
        child.on("error", (error) => { append(error.message); finish(false); });
        child.on("close", (code) => {
          append(stdout.decode(Buffer.alloc(0), true) + stderr.decode(Buffer.alloc(0), true));
          finish(code === 0);
        });
      });
    } finally {
      this.testing.delete(root);
    }
  }

  async start(root: string, goal: MavenGoal, selected: string[], skipTests: boolean): Promise<{ ok: boolean; message?: string; expected?: boolean; state?: MavenTaskState }> {
    root = resolve(root);
    if (!["clean", "compile", "deploy"].includes(goal) || !Array.isArray(selected) || selected.some((path) => typeof path !== "string") || typeof skipTests !== "boolean") {
      return { ok: false, message: l10n.t("Invalid Maven request") };
    }
    if (this.running.has(root) || this.starting.has(root) || this.testing.has(root)) return { ok: false, expected: true, message: l10n.t("A Maven task is already running") };
    this.starting.add(root);
    try {
      const tree = await discoverMavenModules(root);
      const all = selectablePaths(tree);
      if (!all.length) return { ok: false, expected: true, message: l10n.t("No Maven modules are available") };
      let args: string[];
      try { args = buildMavenArgs(goal, selected, all, skipTests, !!tree && !hasWarning(tree)); }
      catch (error) { return { ok: false, expected: true, message: (error as Error).message }; }
      const config = await this.settings(root);
      const { paths, wrapper } = config;
      const problem = await validate(config);
      if (problem) return { ok: false, expected: true, message: problem };
      args = argsWithSettings(args, paths.settings, paths.localRepository);
      const launch = mavenLaunch(paths, process.platform, process.env, wrapper);
      const id = `m${++this.nextId}`;
      const state: MavenTaskState = {
        root, id, goal, status: "running", startedAt: Date.now(),
        command: [launch.command, ...args].map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" "),
        settings: paths.settings || undefined, javaHome: paths.javaHome || undefined, mavenHome: wrapper || paths.mavenHome || undefined,
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = crossSpawn(launch.command, args, {
          cwd: root, env: launch.env, windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) { return { ok: false, message: (error as Error).message }; }
      const entry: Running = { child, state, stopping: false };
      this.running.set(root, entry);
      this.states.set(root, state);
      this.logs.set(root, []);
      this.logChars.set(root, 0);
      this.send("maven:state", { ...state });
      this.log({ root, id, seq: 0, stream: "system", text: `${state.command}\n${wrapper ? "mvnw" : `MAVEN_HOME=${paths.mavenHome || "PATH"}`}  JAVA_HOME=${paths.javaHome || "environment"}  settings=${paths.settings || "Maven default"}  localRepository=${paths.localRepository || "Maven default"}\n` });
      const decoders = { stdout: new ConsoleDecoder(), stderr: new ConsoleDecoder() };
      const pending = { stdout: "", stderr: "" };
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = (): void => {
        flushTimer = undefined;
        for (const stream of ["stdout", "stderr"] as const) {
          if (!pending[stream]) continue;
          this.log({ root, id, seq: 0, stream, text: pending[stream] });
          pending[stream] = "";
        }
      };
      const collect = (stream: "stdout" | "stderr", buffer: Buffer): void => {
        pending[stream] += decoders[stream].decode(buffer);
        if (pending[stream].length >= 16384) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, 50);
      };
      child.stdout.on("data", (b: Buffer) => collect("stdout", b));
      child.stderr.on("data", (b: Buffer) => collect("stderr", b));
      let spawnError: Error | undefined;
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (code) => {
        pending.stdout += decoders.stdout.decode(Buffer.alloc(0), true);
        pending.stderr += decoders.stderr.decode(Buffer.alloc(0), true);
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        if (spawnError) this.log({ root, id, seq: 0, stream: "stderr", text: `${spawnError.message}\n` });
        state.status = entry.stopping ? "stopped" : code === 0 ? "success" : "failed";
        state.exitCode = code ?? undefined;
        state.endedAt = Date.now();
        this.running.delete(root);
        this.send("maven:state", { ...state });
      });
      return { ok: true, state };
    } finally {
      this.starting.delete(root);
    }
  }

  stop(root: string): boolean {
    const task = this.running.get(resolve(root));
    if (!task) return false;
    task.stopping = true;
    this.terminate(task.child);
    return true;
  }

  stopAll(): void { for (const root of this.running.keys()) this.stop(root); }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => { /* already exited */ });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      const pid = child.pid;
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } }, 3000).unref();
    }
  }

  private log(chunk: MavenLogChunk): void {
    chunk.seq = ++this.nextLog;
    const lines = this.logs.get(chunk.root) || [];
    lines.push(chunk);
    let chars = (this.logChars.get(chunk.root) || 0) + chunk.text.length;
    while (lines.length > 4000 || chars > 4_000_000) {
      chars -= lines.shift()?.text.length || 0;
    }
    this.logChars.set(chunk.root, chars);
    this.logs.set(chunk.root, lines);
    this.send("maven:log", chunk);
  }
}
