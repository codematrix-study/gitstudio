import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as l10n from "@vscode/l10n";
import type { GradleModule } from "../shared/ipc";
import { ConsoleDecoder } from "./mavenBridge";

const crossSpawn = require("cross-spawn") as typeof spawn;
const MARK = "__GITSTUDIO_GRADLE_PROJECTS__";
const INIT = `import groovy.json.JsonOutput
gradle.projectsEvaluated {
  def items = gradle.rootProject.allprojects.collect { p ->
    [path: p.path, name: p.name, tasks: p.tasks.names.toList().sort()]
  }
  println "${MARK}" + JsonOutput.toJson(items)
}
`;

export function parseGradleProjects(output: string): GradleModule {
  const line = output.split(/\r?\n/).find((item) => item.startsWith(MARK));
  if (!line) throw new Error(l10n.t("Gradle did not return project information"));
  const data: unknown = JSON.parse(line.slice(MARK.length));
  if (!Array.isArray(data)) throw new Error(l10n.t("Invalid Gradle project information"));
  const nodes = new Map<string, GradleModule>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || !/^:(?:[^:\s]+(?::[^:\s]+)*)?$/.test(row.path) || typeof row.name !== "string") continue;
    const tasks = Array.isArray(row.tasks) ? row.tasks.filter((task): task is string => typeof task === "string" && !/[\s:]/.test(task)) : [];
    nodes.set(row.path, { path: row.path, name: row.name, tasks, children: [] });
  }
  const root = nodes.get(":");
  if (!root) throw new Error(l10n.t("Gradle root project was not found"));
  for (const [path, node] of nodes) {
    if (path === ":") continue;
    const parentPath = path.slice(0, path.lastIndexOf(":")) || ":";
    (nodes.get(parentPath) || root).children.push(node);
  }
  const sort = (node: GradleModule): void => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Ask Gradle itself so dynamic includes and custom registered tasks are visible. */
export async function discoverGradleModules(root: string, command: string, env: NodeJS.ProcessEnv): Promise<GradleModule> {
  const dir = await mkdtemp(join(tmpdir(), "gitstudio-gradle-"));
  const script = join(dir, "inspect.gradle");
  try {
    await writeFile(script, INIT, "utf8");
    const output = await new Promise<string>((done, reject) => {
      const child = crossSpawn(command, ["--console=plain", "-q", "-I", script, "help"], {
        cwd: root, env, windowsHide: true, detached: process.platform !== "win32",
      });
      const stdout = new ConsoleDecoder();
      const stderr = new ConsoleDecoder();
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        if (child.pid && process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
        } else if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
        } else child.kill();
        reject(new Error(l10n.t("Gradle project detection timed out")));
      }, 120000);
      child.stdout.on("data", (chunk: Buffer) => { out = (out + stdout.decode(chunk)).slice(-2_000_000); });
      child.stderr.on("data", (chunk: Buffer) => { err = (err + stderr.decode(chunk)).slice(-16000); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        out += stdout.decode(Buffer.alloc(0), true);
        err += stderr.decode(Buffer.alloc(0), true);
        if (code === 0) done(out);
        else reject(new Error(err.trim() || out.trim() || l10n.t("Gradle exited with code {0}", code ?? "?")));
      });
    });
    return parseGradleProjects(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
