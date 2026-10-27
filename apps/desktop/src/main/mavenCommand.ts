import { join } from "node:path";
import * as l10n from "@vscode/l10n";
import type { MavenGoal, MavenModule, MavenPaths } from "../shared/ipc";

export function selectablePaths(tree: MavenModule | undefined): string[] {
  if (!tree) return [];
  return [...(tree.warning ? [] : [tree.path]), ...tree.children.flatMap(selectablePaths)];
}

export function buildMavenArgs(goal: MavenGoal, selected: string[], all: string[], skipTests: boolean, completeReactor = true): string[] {
  const valid = new Set(all);
  if (!selected.length || selected.some((path) => !valid.has(path) || path.includes(","))) {
    throw new Error(l10n.t("Select valid Maven modules before running a goal"));
  }
  const chosen = [...new Set(selected)];
  const args = ["-B", goal];
  if (chosen.length !== all.length || !completeReactor) args.push("-pl", chosen.join(","));
  if (skipTests) args.push("-DskipTests");
  return args;
}

export function mavenLaunch(paths: MavenPaths, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): {
  command: string;
  env: NodeJS.ProcessEnv;
} {
  const command = paths.mavenHome
    ? join(paths.mavenHome, "bin", platform === "win32" ? "mvn.cmd" : "mvn")
    : platform === "win32" ? "mvn.cmd" : "mvn";
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const prefixes = [paths.mavenHome && join(paths.mavenHome, "bin"), paths.javaHome && join(paths.javaHome, "bin")].filter(Boolean);
  const next = { ...env };
  if (paths.mavenHome) next.MAVEN_HOME = paths.mavenHome;
  if (paths.javaHome) next.JAVA_HOME = paths.javaHome;
  if (prefixes.length) next[pathKey] = [...prefixes, env[pathKey] || ""].join(platform === "win32" ? ";" : ":");
  return { command, env: next };
}

export function argsWithSettings(args: string[], settings: string): string[] {
  return settings ? [...args, "-s", settings] : args;
}
