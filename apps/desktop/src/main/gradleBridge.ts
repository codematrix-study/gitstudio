import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as l10n from "@vscode/l10n";
import type { GradleLogChunk, GradleModule, GradlePaths, GradleTaskState } from "../shared/ipc";
import { buildGradleArgs, gradleLaunch } from "./gradleCommand";
import { discoverGradleModules } from "./gradleModules";
import { ConsoleDecoder } from "./mavenBridge";

const crossSpawn = require("cross-spawn") as typeof spawn;

export interface GradleLaunchConfig { paths: GradlePaths; wrapper?: string }
interface Running { child: ChildProcessWithoutNullStreams; state: GradleTaskState; stopping: boolean }

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function validate(config: GradleLaunchConfig): Promise<string | undefined> {
  const { paths, wrapper } = config;
  if (wrapper && !(await isFile(wrapper))) return l10n.t("The Gradle wrapper is missing");
  if (!wrapper && paths.gradleHome && !(await isFile(join(paths.gradleHome, "bin", process.platform === "win32" ? "gradle.bat" : "gradle")))) {
    return l10n.t("Gradle directory must contain bin/gradle (bin/gradle.bat on Windows)");
  }
  if (paths.javaHome && !(await isFile(join(paths.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")))) {
    return l10n.t("JAVA_HOME must contain bin/java (bin/java.exe on Windows)");
  }
  return undefined;
}

export class GradleBridge {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Set<string>();
  private readonly testing = new Set<string>();
  private readonly states = new Map<string, GradleTaskState>();
  private readonly logs = new Map<string, GradleLogChunk[]>();
  private readonly logChars = new Map<string, number>();
  private readonly projects = new Map<string, GradleModule>();
  private nextId = 0;
  private nextLog = 0;

  constructor(
    private readonly settings: (root: string | undefined) => Promise<GradleLaunchConfig>,
    private readonly send: (event: "gradle:log" | "gradle:state", data: GradleLogChunk | GradleTaskState) => void,
  ) {}

  state(root: string): GradleTaskState | undefined { return this.states.get(resolve(root)); }
  logSnapshot(root: string): GradleLogChunk[] { return [...(this.logs.get(resolve(root)) || [])]; }

  async modules(root: string): Promise<GradleModule> {
    root = resolve(root);
    let tree: GradleModule;
    try {
      const config = await this.settings(root);
      const problem = await validate(config);
      if (problem) throw new Error(problem);
      const launch = gradleLaunch(config.paths, process.platform, process.env, config.wrapper);
      tree = await discoverGradleModules(root, launch.command, launch.env);
    } catch (error) {
      // Fixed tasks remain usable when task introspection cannot configure the build.
      tree = { path: ":", name: basename(root), tasks: [], children: [], warning: String(error) };
    }
    this.projects.set(root, tree);
    return tree;
  }

  async test(project: string | undefined): Promise<{ ok: boolean; output: string }> {
    const root = project ? resolve(project) : "";
    if ((root && (this.running.has(root) || this.starting.has(root))) || this.testing.has(root)) {
      return { ok: false, output: l10n.t("A Gradle task is already running") };
    }
    this.testing.add(root);
    try {
      const config = await this.settings(root || undefined);
      const problem = await validate(config);
      if (problem) return { ok: false, output: problem };
      const launch = gradleLaunch(config.paths, process.platform, process.env, config.wrapper);
      return await new Promise((done) => {
        const child = crossSpawn(launch.command, ["-v"], {
          cwd: root || homedir(), env: launch.env, windowsHide: true, detached: process.platform !== "win32",
        });
        const stdout = new ConsoleDecoder();
        const stderr = new ConsoleDecoder();
        let output = "";
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          done({ ok, output: output.trim() });
        };
        child.stdout.on("data", (chunk: Buffer) => { output = (output + stdout.decode(chunk)).slice(-16000); });
        child.stderr.on("data", (chunk: Buffer) => { output = (output + stderr.decode(chunk)).slice(-16000); });
        const timeout = setTimeout(() => { this.terminate(child); output += `\n${l10n.t("Gradle version check timed out")}`; finish(false); }, 15000);
        child.on("error", (error) => { output += error.message; finish(false); });
        child.on("close", (code) => {
          output += stdout.decode(Buffer.alloc(0), true) + stderr.decode(Buffer.alloc(0), true);
          finish(code === 0);
        });
      });
    } finally { this.testing.delete(root); }
  }

  async start(root: string, goal: string, selected: string[]): Promise<{ ok: boolean; message?: string; expected?: boolean; state?: GradleTaskState }> {
    root = resolve(root);
    if (typeof goal !== "string" || !Array.isArray(selected) || selected.some((path) => typeof path !== "string")) {
      return { ok: false, expected: true, message: l10n.t("Invalid Gradle request") };
    }
    if (this.running.has(root) || this.starting.has(root) || this.testing.has(root)) {
      return { ok: false, expected: true, message: l10n.t("A Gradle task is already running") };
    }
    this.starting.add(root);
    try {
      const tree = this.projects.get(root) || await this.modules(root);
      let args: string[];
      try { args = buildGradleArgs(goal, selected, tree); }
      catch (error) { return { ok: false, expected: true, message: (error as Error).message }; }
      const config = await this.settings(root);
      const problem = await validate(config);
      if (problem) return { ok: false, expected: true, message: problem };
      const launch = gradleLaunch(config.paths, process.platform, process.env, config.wrapper);
      const id = `g${++this.nextId}`;
      const state: GradleTaskState = {
        root, id, goal, status: "running", startedAt: Date.now(),
        command: [launch.command, ...args].map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" "),
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = crossSpawn(launch.command, args, { cwd: root, env: launch.env, windowsHide: true, detached: process.platform !== "win32" });
      } catch (error) { return { ok: false, message: (error as Error).message }; }
      const entry: Running = { child, state, stopping: false };
      this.running.set(root, entry);
      this.states.set(root, state);
      this.logs.set(root, []);
      this.logChars.set(root, 0);
      this.send("gradle:state", { ...state });
      this.log({ root, id, seq: 0, stream: "system", text: `${state.command}\n${config.wrapper ? "gradlew" : `GRADLE_HOME=${config.paths.gradleHome || "PATH"}`}  GRADLE_USER_HOME=${config.paths.userHome || "default"}  JAVA_HOME=${config.paths.javaHome || "environment"}\n` });
      const decoders = { stdout: new ConsoleDecoder(), stderr: new ConsoleDecoder() };
      child.stdout.on("data", (bytes: Buffer) => this.log({ root, id, seq: 0, stream: "stdout", text: decoders.stdout.decode(bytes) }));
      child.stderr.on("data", (bytes: Buffer) => this.log({ root, id, seq: 0, stream: "stderr", text: decoders.stderr.decode(bytes) }));
      let spawnError: Error | undefined;
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (code) => {
        for (const stream of ["stdout", "stderr"] as const) {
          const text = decoders[stream].decode(Buffer.alloc(0), true);
          if (text) this.log({ root, id, seq: 0, stream, text });
        }
        if (spawnError) this.log({ root, id, seq: 0, stream: "stderr", text: `${spawnError.message}\n` });
        state.status = entry.stopping ? "stopped" : code === 0 ? "success" : "failed";
        state.exitCode = code ?? undefined;
        state.endedAt = Date.now();
        this.running.delete(root);
        this.send("gradle:state", { ...state });
      });
      return { ok: true, state };
    } finally { this.starting.delete(root); }
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
      killer.on("error", () => {});
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
  }

  private log(chunk: GradleLogChunk): void {
    if (!chunk.text) return;
    chunk.seq = ++this.nextLog;
    const lines = this.logs.get(chunk.root) || [];
    lines.push(chunk);
    let chars = (this.logChars.get(chunk.root) || 0) + chunk.text.length;
    while (lines.length > 4000 || chars > 4_000_000) chars -= lines.shift()?.text.length || 0;
    this.logChars.set(chunk.root, chars);
    this.logs.set(chunk.root, lines);
    this.send("gradle:log", chunk);
  }
}
