import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildMavenArgs, argsWithSettings, mavenLaunch } from "../src/main/mavenCommand";
import { AppSettings, resolveMavenPaths } from "../src/main/appSettings";

test("Maven args use -pl only for a proper subset and keep goals independent", () => {
  const all = [".", "服务/api", "web app"];
  assert.deepEqual(buildMavenArgs("clean", all, all, false), ["-B", "clean"]);
  assert.deepEqual(buildMavenArgs("compile", ["服务/api", "web app"], all, true),
    ["-B", "compile", "-pl", "服务/api,web app", "-DskipTests"]);
  assert.deepEqual(argsWithSettings(buildMavenArgs("deploy", ["."], all, false), "/tmp/with space/settings.xml"),
    ["-B", "deploy", "-pl", ".", "-s", "/tmp/with space/settings.xml"]);
  assert.throws(() => buildMavenArgs("compile", [], all, false));
  assert.throws(() => buildMavenArgs("compile", ["../unlisted"], all, false));
});

test("project paths override global paths, then environment, independently", () => {
  const result = resolveMavenPaths(
    { mavenHome: "", settings: "/project/settings.xml", javaHome: "" },
    { mavenHome: "/global/maven", settings: "", javaHome: "/global/java" },
    { MAVEN_HOME: "/env/maven", MAVEN_SETTINGS: "/env/settings.xml", JAVA_HOME: "/env/java" },
  );
  assert.deepEqual(result, { mavenHome: "/global/maven", settings: "/project/settings.xml", javaHome: "/global/java" });
  assert.deepEqual(resolveMavenPaths({ mavenHome: "", settings: "", javaHome: "" },
    { mavenHome: "", settings: "", javaHome: "" }, { MAVEN_HOME: "/env/maven", JAVA_HOME: "/env/java" }),
  { mavenHome: "/env/maven", settings: "", javaHome: "/env/java" });
});

test("custom Maven and Java bins lead PATH without merging arguments into a shell command", () => {
  const launch = mavenLaunch({ mavenHome: "/工具/Maven Home", settings: "", javaHome: "/工具/Java Home" },
    "darwin", { PATH: "/usr/bin" });
  assert.equal(launch.command, "/工具/Maven Home/bin/mvn");
  assert.equal(launch.env.PATH, "/工具/Maven Home/bin:/工具/Java Home/bin:/usr/bin");
  assert.equal(launch.env.JAVA_HOME, "/工具/Java Home");
});

test("Windows chooses mvn.cmd and keeps the configured directories in the launch environment", () => {
  const launch = mavenLaunch({ mavenHome: "C:\\工具\\Maven Home", settings: "", javaHome: "C:\\Java Home" },
    "win32", { PATH: "C:\\Windows" });
  assert.equal(launch.command, join("C:\\工具\\Maven Home", "bin", "mvn.cmd"));
  assert.equal(launch.env.MAVEN_HOME, "C:\\工具\\Maven Home");
  assert.equal(launch.env.JAVA_HOME, "C:\\Java Home");
  assert.match(launch.env.PATH || "", /Maven Home/);
});

test("Maven global and project overrides persist outside the repository", async () => {
  const userData = await mkdtemp(join(tmpdir(), "gitstudio-maven-config-"));
  const repo = join(userData, "a project");
  try {
    const store = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    await store.setMavenSettings(repo, "global", { mavenHome: "/global/maven", javaHome: "/global/java" });
    await store.setMavenSettings(repo, "project", { mavenHome: "/project/maven", settings: "/project/settings.xml" });
    const reloaded = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    assert.deepEqual(reloaded.mavenSettings(repo, {} as NodeJS.ProcessEnv).effective,
      { mavenHome: "/project/maven", settings: "/project/settings.xml", javaHome: "/global/java" });
    assert.equal(reloaded.mavenSettings(join(userData, "other"), {} as NodeJS.ProcessEnv).effective.mavenHome, "/global/maven");
  } finally { await rm(userData, { recursive: true, force: true }); }
});
