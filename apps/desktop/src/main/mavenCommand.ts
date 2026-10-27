import { join } from "node:path";
import * as l10n from "@vscode/l10n";
import type { MavenGoal, MavenModule, MavenPaths, MavenSettingsView } from "../shared/ipc";

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

/**
 * What a run actually uses. Maven home and JDK take the detected values too —
 * a GUI app's PATH has neither — but settings.xml and the local repository are
 * passed only when someone chose them: what detection finds there is exactly
 * what Maven reads by default, and `-s` would demote a global conf/settings.xml
 * to user settings.
 */
export function launchPaths(view: MavenSettingsView): MavenPaths {
  const chosen = (key: keyof MavenPaths): string => view.project?.[key].trim() || view.global[key].trim();
  return {
    mavenHome: view.effective.mavenHome,
    javaHome: view.effective.javaHome,
    settings: chosen("settings"),
    localRepository: chosen("localRepository"),
  };
}

/** `wrapper`: the repository's mvnw, which then runs instead of Maven home. */
export function mavenLaunch(paths: MavenPaths, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, wrapper?: string): {
  command: string;
  env: NodeJS.ProcessEnv;
} {
  const mavenHome = wrapper ? "" : paths.mavenHome;
  const command = wrapper
    || (mavenHome ? join(mavenHome, "bin", platform === "win32" ? "mvn.cmd" : "mvn") : platform === "win32" ? "mvn.cmd" : "mvn");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const prefixes = [mavenHome && join(mavenHome, "bin"), paths.javaHome && join(paths.javaHome, "bin")].filter(Boolean);
  const next = { ...env };
  if (mavenHome) next.MAVEN_HOME = mavenHome;
  if (paths.javaHome) next.JAVA_HOME = paths.javaHome;
  if (prefixes.length) next[pathKey] = [...prefixes, env[pathKey] || ""].join(platform === "win32" ? ";" : ":");
  return { command, env: next };
}

export function argsWithSettings(args: string[], settings: string, localRepository = ""): string[] {
  const out = settings ? [...args, "-s", settings] : [...args];
  if (localRepository) out.push(`-Dmaven.repo.local=${localRepository}`);
  return out;
}
