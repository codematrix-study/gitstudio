import { join } from "node:path";
import * as l10n from "@vscode/l10n";
import type { GradleModule, GradlePaths, GradleSettingsView } from "../shared/ipc";

export function gradlePathsForLaunch(view: GradleSettingsView): GradlePaths {
  return view.effective;
}

export function gradleLaunch(paths: GradlePaths, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, wrapper?: string): {
  command: string;
  env: NodeJS.ProcessEnv;
} {
  const home = wrapper ? "" : paths.gradleHome;
  const command = wrapper || (home ? join(home, "bin", platform === "win32" ? "gradle.bat" : "gradle") : platform === "win32" ? "gradle.bat" : "gradle");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const prefixes = [home && join(home, "bin"), paths.javaHome && join(paths.javaHome, "bin")].filter(Boolean);
  const next = { ...env };
  if (home) next.GRADLE_HOME = home;
  if (paths.userHome) next.GRADLE_USER_HOME = paths.userHome;
  if (paths.javaHome) next.JAVA_HOME = paths.javaHome;
  if (prefixes.length) next[pathKey] = [...prefixes, env[pathKey] || ""].join(platform === "win32" ? ";" : ":");
  return { command, env: next };
}

export function flattenGradleModules(tree: GradleModule | undefined): GradleModule[] {
  return tree ? [tree, ...tree.children.flatMap(flattenGradleModules)] : [];
}

export function buildGradleArgs(goal: string, selected: string[], tree: GradleModule): string[] {
  const available = new Map(flattenGradleModules(tree).map((node) => [node.path, node]));
  if (!selected.length || selected.some((path) => !available.has(path)) || !goal || /^-/.test(goal) || /[\s:]/.test(goal)) {
    throw new Error(l10n.t("Select valid Gradle modules and a task"));
  }
  const chosen = [...new Set(selected)];
  const fixed = new Set(["clean", "assembleDebug", "assembleRelease", "bundleDebug", "bundleRelease"]);
  const customAvailable = chosen.includes(":")
    ? flattenGradleModules(tree).some((node) => node.tasks.includes(goal))
    : chosen.every((path) => available.get(path)!.tasks.includes(goal));
  if (!fixed.has(goal) && !customAvailable) {
    throw new Error(l10n.t("The task {0} is not available in every selected module", goal));
  }
  // A root selection means the Gradle task selector, which visits all projects.
  const tasks = chosen.includes(":") ? [goal] : chosen.map((path) => `${path}:${goal}`);
  return ["--console=plain", ...tasks];
}
