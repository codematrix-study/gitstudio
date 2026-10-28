import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GradleDetected } from "../shared/ipc";
import { loginShellEnv, mavenDetection } from "./mavenDetect";

function gradleBinary(home: string): string {
  return join(home, "bin", process.platform === "win32" ? "gradle.bat" : "gradle");
}

function findOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  const dirs = (env[key] || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  if (process.platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  for (const dir of dirs) {
    for (const ext of process.platform === "win32" ? [".bat", ".cmd", ".exe"] : [""]) {
      const file = join(dir, `gradle${ext}`);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

async function detectHere(recheck = false): Promise<GradleDetected> {
  const env = { ...process.env, ...(await loginShellEnv()) };
  const java = await mavenDetection(recheck);
  let gradleHome = "";
  let homeSource = "";
  const configured = env.GRADLE_HOME?.trim();
  if (configured && existsSync(gradleBinary(configured))) {
    gradleHome = configured;
    homeSource = "GRADLE_HOME";
  } else {
    const binary = findOnPath(env);
    if (binary) {
      let real = binary;
      try { real = realpathSync(binary); } catch { /* use the PATH entry */ }
      const candidate = dirname(dirname(real));
      if (existsSync(gradleBinary(candidate))) {
        gradleHome = candidate;
        homeSource = "PATH";
      }
    }
    if (!gradleHome) {
      for (const [candidate, source] of [
        [join(homedir(), ".sdkman", "candidates", "gradle", "current"), "SDKMAN"],
        [join(homedir(), "scoop", "apps", "gradle", "current"), "Scoop"],
      ]) {
        if (existsSync(gradleBinary(candidate))) { gradleHome = candidate; homeSource = source; break; }
      }
    }
  }
  const userHome = env.GRADLE_USER_HOME?.trim() || join(homedir(), ".gradle");
  return {
    paths: { gradleHome, userHome, javaHome: java.paths.javaHome },
    sources: { gradleHome: homeSource, userHome: env.GRADLE_USER_HOME ? "GRADLE_USER_HOME" : "default", javaHome: java.sources.javaHome },
  };
}

let cached: Promise<GradleDetected> | undefined;
export function gradleDetection(recheck = false): Promise<GradleDetected> {
  if (recheck || !cached) cached = detectHere(recheck);
  return cached;
}

export function gradleWrapper(root: string): string | undefined {
  const script = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  try { return existsSync(script) ? script : undefined; } catch { return undefined; }
}
