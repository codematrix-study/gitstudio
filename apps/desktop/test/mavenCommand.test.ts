import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildMavenArgs, argsWithSettings, launchPaths, mavenLaunch } from "../src/main/mavenCommand";
import { AppSettings, EMPTY_MAVEN, resolveMavenPaths } from "../src/main/appSettings";
import type { MavenDetected } from "../src/shared/ipc";

const detected: MavenDetected = {
  paths: { mavenHome: "/detected/maven", settings: "/home/me/.m2/settings.xml", localRepository: "/home/me/.m2/repository", javaHome: "/detected/java" },
  sources: { mavenHome: "PATH", settings: "~/.m2", localRepository: "default", javaHome: "JAVA_HOME" },
};

test("Maven args use -pl only for a proper subset and keep goals independent", () => {
  const all = [".", "服务/api", "web app"];
  assert.deepEqual(buildMavenArgs("clean", all, all, false), ["-B", "clean"]);
  assert.deepEqual(buildMavenArgs("compile", ["服务/api", "web app"], all, true),
    ["-B", "compile", "-pl", "服务/api,web app", "-DskipTests"]);
  assert.deepEqual(argsWithSettings(buildMavenArgs("deploy", ["."], all, false), "/tmp/with space/settings.xml"),
    ["-B", "deploy", "-pl", ".", "-s", "/tmp/with space/settings.xml"]);
  assert.deepEqual(argsWithSettings(["-B", "clean"], "", "/repo with space"),
    ["-B", "clean", "-Dmaven.repo.local=/repo with space"]);
  assert.throws(() => buildMavenArgs("compile", [], all, false));
  assert.throws(() => buildMavenArgs("compile", ["../unlisted"], all, false));
});

test("project paths override global paths, then the detected ones, independently", () => {
  const result = resolveMavenPaths(
    { ...EMPTY_MAVEN, settings: "/project/settings.xml" },
    { ...EMPTY_MAVEN, mavenHome: "/global/maven", javaHome: "/global/java" },
    detected.paths,
  );
  assert.deepEqual(result, {
    mavenHome: "/global/maven", settings: "/project/settings.xml",
    localRepository: "/home/me/.m2/repository", javaHome: "/global/java",
  });
  assert.deepEqual(resolveMavenPaths(EMPTY_MAVEN, EMPTY_MAVEN, detected.paths), detected.paths);
});

test("a run passes -s and the local repository only when someone chose them", () => {
  const store = { global: EMPTY_MAVEN, project: EMPTY_MAVEN };
  const view = { ...store, detected, effective: detected.paths, wrapperAvailable: false, wrapper: false };
  assert.deepEqual(launchPaths(view), { mavenHome: "/detected/maven", javaHome: "/detected/java", settings: "", localRepository: "" });
  const chosen = { ...view, global: { ...EMPTY_MAVEN, settings: "/global/settings.xml" }, project: { ...EMPTY_MAVEN, localRepository: "/repo" } };
  assert.deepEqual(launchPaths(chosen), { mavenHome: "/detected/maven", javaHome: "/detected/java", settings: "/global/settings.xml", localRepository: "/repo" });
});

test("custom Maven and Java bins lead PATH without merging arguments into a shell command", () => {
  const launch = mavenLaunch({ ...EMPTY_MAVEN, mavenHome: "/工具/Maven Home", javaHome: "/工具/Java Home" },
    "darwin", { PATH: "/usr/bin" });
  assert.equal(launch.command, "/工具/Maven Home/bin/mvn");
  assert.equal(launch.env.PATH, "/工具/Maven Home/bin:/工具/Java Home/bin:/usr/bin");
  assert.equal(launch.env.JAVA_HOME, "/工具/Java Home");
});

test("the wrapper runs instead of Maven home and keeps the JDK", () => {
  const launch = mavenLaunch({ ...EMPTY_MAVEN, mavenHome: "/maven", javaHome: "/java" }, "darwin", { PATH: "/usr/bin" }, "/repo/mvnw");
  assert.equal(launch.command, "/repo/mvnw");
  assert.equal(launch.env.PATH, "/java/bin:/usr/bin");
  assert.equal(launch.env.MAVEN_HOME, undefined);
  assert.equal(launch.env.JAVA_HOME, "/java");
});

test("Windows chooses mvn.cmd and keeps the configured directories in the launch environment", () => {
  const launch = mavenLaunch({ ...EMPTY_MAVEN, mavenHome: "C:\\工具\\Maven Home", javaHome: "C:\\Java Home" },
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
    await store.setMavenSettings(undefined, "global", { mavenHome: "/global/maven", javaHome: "/global/java" });
    await store.setMavenSettings(repo, "project", { mavenHome: "/project/maven", settings: "/project/settings.xml", useWrapper: false });
    const reloaded = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    const view = reloaded.mavenSettings(repo, detected, true);
    assert.deepEqual(view.effective, {
      mavenHome: "/project/maven", settings: "/project/settings.xml",
      localRepository: "/home/me/.m2/repository", javaHome: "/global/java",
    });
    assert.equal(view.useWrapper, false);
    assert.equal(view.wrapper, false);
    assert.equal(reloaded.mavenSettings(join(userData, "other"), detected, true).wrapper, true);
    const global = reloaded.mavenSettings(undefined, detected);
    assert.equal(global.project, undefined);
    assert.equal(global.effective.mavenHome, "/global/maven");
    await reloaded.setMavenSettings(repo, "project", { useWrapper: null });
    assert.equal(reloaded.mavenSettings(repo, detected, true).wrapper, true);
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test("settings saved before the local repository field existed still load", async () => {
  const userData = await mkdtemp(join(tmpdir(), "gitstudio-maven-legacy-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(userData, "app-settings.json"), JSON.stringify({
      mavenGlobal: { mavenHome: "/old/maven", settings: "", javaHome: "" },
    }));
    const store = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    const view = store.mavenSettings(undefined, detected);
    assert.equal(view.global.localRepository, "");
    assert.equal(view.effective.mavenHome, "/old/maven");
    assert.equal(view.effective.localRepository, "/home/me/.m2/repository");
  } finally { await rm(userData, { recursive: true, force: true }); }
});
