// The machine's own Maven setup, found the way IntelliJ IDEA finds it, so the
// Deploy view works with no configuration and Settings can show what an empty
// field falls back to:
//   • Maven home      MAVEN_HOME → M2_HOME → `mvn` on PATH → SDKMAN / Scoop
//   • settings.xml    ~/.m2/settings.xml → <maven home>/conf/settings.xml
//   • local repo      <localRepository> in either settings.xml → ~/.m2/repository
//   • JDK             JAVA_HOME → /usr/libexec/java_home (macOS) → `java` on PATH → SDKMAN
//
// An app started from the Dock or Finder does not inherit the login shell's
// environment, so MAVEN_HOME exported in ~/.zshrc is invisible to it. The
// OS-touching half therefore asks the login shell once for the few variables
// that matter here. `detectMaven` itself is pure (every probe is injected) and
// unit-tested.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import type { MavenDetected, MavenPaths } from "../shared/ipc";

export interface MavenDetectDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  /** Resolve symlinks; return the path unchanged when it cannot. */
  realpath: (path: string) => string;
  readFile: (path: string) => string | undefined;
  /** What `/usr/libexec/java_home` printed (macOS only). */
  javaHomeTool?: string;
}

type Found = { value: string; source: string };
const NONE: Found = { value: "", source: "" };

function paths(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function envPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  return (key && env[key]) || "";
}

/** PATH, plus where Homebrew and friends put CLIs that a GUI app's PATH lacks. */
function searchDirs(d: MavenDetectDeps): string[] {
  const fromPath = envPath(d.env).split(d.platform === "win32" ? ";" : ":").filter(Boolean);
  if (d.platform === "win32") return fromPath;
  return [...fromPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", posix.join(d.home, ".local", "bin")];
}

function findOnPath(d: MavenDetectDeps, name: string): string | undefined {
  const p = paths(d.platform);
  const exts = d.platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
  for (const dir of searchDirs(d)) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (d.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `dir` as a Maven home. Homebrew's Cellar keeps a stub bin/ beside the real
 *  installation in libexec/, so that one wins when it is there. */
function mavenHomeAt(d: MavenDetectDeps, dir: string): string | undefined {
  const p = paths(d.platform);
  const mvn = d.platform === "win32" ? "mvn.cmd" : "mvn";
  for (const home of [p.join(dir, "libexec"), dir]) {
    if (d.exists(p.join(home, "bin", mvn))) return home;
  }
  return undefined;
}

function javaHomeAt(d: MavenDetectDeps, dir: string): string | undefined {
  const p = paths(d.platform);
  return d.exists(p.join(dir, "bin", d.platform === "win32" ? "java.exe" : "java")) ? dir : undefined;
}

function detectMavenHome(d: MavenDetectDeps): Found {
  const p = paths(d.platform);
  for (const key of ["MAVEN_HOME", "M2_HOME"]) {
    const value = d.env[key]?.trim();
    const home = value && mavenHomeAt(d, value);
    if (home) return { value: home, source: key };
  }
  const mvn = findOnPath(d, "mvn");
  if (mvn) {
    const home = mavenHomeAt(d, p.dirname(p.dirname(d.realpath(mvn))));
    if (home) return { value: home, source: "PATH" };
  }
  const managers: Array<[string, string]> = [[p.join(d.home, ".sdkman", "candidates", "maven", "current"), "SDKMAN"]];
  if (d.platform === "win32") managers.push([p.join(d.home, "scoop", "apps", "maven", "current"), "Scoop"]);
  for (const [dir, source] of managers) {
    const home = mavenHomeAt(d, dir);
    if (home) return { value: home, source };
  }
  return NONE;
}

function detectJavaHome(d: MavenDetectDeps): Found {
  const p = paths(d.platform);
  const env = d.env.JAVA_HOME?.trim();
  if (env && javaHomeAt(d, env)) return { value: env, source: "JAVA_HOME" };
  const tool = d.javaHomeTool?.trim();
  if (tool && javaHomeAt(d, tool)) return { value: tool, source: "java_home" };
  const java = findOnPath(d, "java");
  if (java) {
    const real = d.realpath(java);
    // macOS's /usr/bin/java is a stub that asks java_home; /usr is no JDK.
    const home = !(d.platform === "darwin" && real === "/usr/bin/java") && javaHomeAt(d, p.dirname(p.dirname(real)));
    if (home) return { value: home, source: "PATH" };
  }
  const sdkman = p.join(d.home, ".sdkman", "candidates", "java", "current");
  if (javaHomeAt(d, sdkman)) return { value: sdkman, source: "SDKMAN" };
  return NONE;
}

/** The <localRepository> a settings.xml names, with ${user.home} and ${env.X}
 *  expanded the way Maven expands them. */
export function localRepositoryIn(xml: string, home: string, env: NodeJS.ProcessEnv): string | undefined {
  let root: Element | null | undefined;
  try {
    root = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } })
      .parseFromString(xml, "application/xml")?.documentElement;
  } catch { return undefined; }
  if (!root || (root.localName || root.nodeName) !== "settings") return undefined;
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1 || ((node as Element).localName || node.nodeName) !== "localRepository") continue;
    const value = (node.textContent || "").trim()
      .replace(/\$\{user\.home\}/g, home)
      .replace(/\$\{env\.([^}]+)\}/g, (_, name: string) => env[name] ?? "");
    return value || undefined;
  }
  return undefined;
}

export function detectMaven(d: MavenDetectDeps): MavenDetected {
  const p = paths(d.platform);
  const mavenHome = detectMavenHome(d);
  const userSettings = p.join(d.home, ".m2", "settings.xml");
  const confSettings = mavenHome.value ? p.join(mavenHome.value, "conf", "settings.xml") : "";
  const settings: Found = d.exists(userSettings) ? { value: userSettings, source: "~/.m2" }
    : confSettings && d.exists(confSettings) ? { value: confSettings, source: "conf" }
    : NONE;
  let localRepository: Found = { value: p.join(d.home, ".m2", "repository"), source: "default" };
  for (const file of [userSettings, confSettings]) {
    const xml = file && d.exists(file) ? d.readFile(file) : undefined;
    const named = xml && localRepositoryIn(xml, d.home, d.env);
    if (named) { localRepository = { value: named, source: "settings.xml" }; break; }
  }
  const javaHome = detectJavaHome(d);
  const found: Record<keyof MavenPaths, Found> = { mavenHome, settings, localRepository, javaHome };
  return {
    paths: {
      mavenHome: found.mavenHome.value,
      settings: found.settings.value,
      localRepository: found.localRepository.value,
      javaHome: found.javaHome.value,
    },
    sources: {
      mavenHome: found.mavenHome.source,
      settings: found.settings.source,
      localRepository: found.localRepository.source,
      javaHome: found.javaHome.source,
    },
  };
}

// ── The OS-touching half ────────────────────────────────────────────────────

const MARK = "__GITSTUDIO_ENV__";
const SHELL_KEYS = new Set(["PATH", "MAVEN_HOME", "M2_HOME", "GRADLE_HOME", "GRADLE_USER_HOME", "JAVA_HOME"]);

/** The variables Maven detection reads, out of `env` printed between marks
 *  (anything an rc file prints around them is ignored). */
export function parseShellEnv(output: string): NodeJS.ProcessEnv {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start < 0 || end <= start) return {};
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.slice(start + MARK.length, end).split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && SHELL_KEYS.has(line.slice(0, eq))) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      execFile(command, args, { timeout: 5000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        done(error ? undefined : stdout);
      });
    } catch { done(undefined); }
  });
}

export async function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return {};
  const out = await run(process.env.SHELL || "/bin/sh", ["-ilc", `echo ${MARK}; env; echo ${MARK}`]);
  return out ? parseShellEnv(out) : {};
}

async function detectHere(): Promise<MavenDetected> {
  const env = { ...process.env, ...(await loginShellEnv()) };
  const javaHomeTool = process.platform === "darwin" ? await run("/usr/libexec/java_home", []) : undefined;
  return detectMaven({
    platform: process.platform,
    home: homedir(),
    env,
    javaHomeTool,
    exists: (path) => { try { return existsSync(path); } catch { return false; } },
    realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
    readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  });
}

let cached: Promise<MavenDetected> | undefined;

/** This machine's Maven setup, looked up once per run (or again on request). */
export function mavenDetection(recheck = false): Promise<MavenDetected> {
  if (recheck || !cached) cached = detectHere();
  return cached;
}

/** The repository's Maven wrapper script, if it has one. */
export function mavenWrapper(root: string): string | undefined {
  const script = join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  try { return existsSync(script) ? script : undefined; } catch { return undefined; }
}
