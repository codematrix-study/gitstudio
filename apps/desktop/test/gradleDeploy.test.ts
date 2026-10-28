import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettings, EMPTY_GRADLE, resolveGradlePaths } from "../src/main/appSettings";
import { detectBuildManagers } from "../src/main/buildManagerDetect";
import { buildGradleArgs, gradleLaunch } from "../src/main/gradleCommand";
import { parseGradleProjects } from "../src/main/gradleModules";
import { GradleBridge } from "../src/main/gradleBridge";
import type { GradleDetected } from "../src/shared/ipc";

const detected: GradleDetected = {
  paths: { gradleHome: "/detected/gradle", userHome: "/home/me/.gradle", javaHome: "/detected/java" },
  sources: { gradleHome: "PATH", userHome: "default", javaHome: "JAVA_HOME" },
};

test("build manager detection recognizes both and neither without reading child directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitstudio-managers-"));
  try {
    assert.deepEqual(await detectBuildManagers(root), { maven: false, gradle: false });
    await writeFile(join(root, "settings.gradle.kts"), "rootProject.name = \"demo\"");
    assert.deepEqual(await detectBuildManagers(root), { maven: false, gradle: true });
    await writeFile(join(root, "pom.xml"), "<project/>");
    assert.deepEqual(await detectBuildManagers(root), { maven: true, gradle: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Gradle project report preserves nested projects and custom tasks", () => {
  const report = '__GITSTUDIO_GRADLE_PROJECTS__' + JSON.stringify([
    { path: ":", name: "root", tasks: ["clean", "help"] },
    { path: ":app", name: "app", tasks: ["assembleDebug", "bundleRelease", "packageDemo"] },
    { path: ":feature:login", name: "login", tasks: ["assembleDebug", "packageDemo"] },
    { path: ":feature", name: "feature", tasks: ["clean"] },
  ]);
  const tree = parseGradleProjects(`warning\n${report}\n`);
  assert.deepEqual(tree.children.map((node) => node.path), [":app", ":feature"]);
  assert.deepEqual(tree.children[1].children.map((node) => node.path), [":feature:login"]);
  assert.deepEqual(buildGradleArgs("assembleDebug", [":app", ":feature:login"], tree),
    ["--console=plain", ":app:assembleDebug", ":feature:login:assembleDebug"]);
  assert.deepEqual(buildGradleArgs("bundleRelease", [":"], tree), ["--console=plain", "bundleRelease"]);
  assert.deepEqual(buildGradleArgs("packageDemo", [":app"], tree), ["--console=plain", ":app:packageDemo"]);
  assert.deepEqual(buildGradleArgs("packageDemo", [":"], tree), ["--console=plain", "packageDemo"]);
  assert.throws(() => buildGradleArgs("packageDemo", [":feature"], tree));
  assert.throws(() => buildGradleArgs("--offline", [":"], tree));
});

test("Gradle settings inherit by field and retain separate project overrides", async () => {
  const userData = await mkdtemp(join(tmpdir(), "gitstudio-gradle-config-"));
  const repo = join(userData, "a project");
  try {
    const store = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    await store.setGradleSettings(undefined, "global", { gradleHome: "/global/gradle", userHome: "/global/cache" });
    await store.setGradleSettings(repo, "project", { userHome: "/project/cache", useWrapper: false });
    const reloaded = await AppSettings.load(userData, { defaultCloneDir: userData, home: userData });
    const view = reloaded.gradleSettings(repo, detected, true);
    assert.deepEqual(view.effective, { gradleHome: "/global/gradle", userHome: "/project/cache", javaHome: "/detected/java" });
    assert.equal(view.wrapper, false);
    assert.equal(reloaded.gradleSettings(join(userData, "other"), detected, true).wrapper, true);
    assert.deepEqual(resolveGradlePaths(EMPTY_GRADLE, EMPTY_GRADLE, detected.paths), detected.paths);
    await reloaded.setGradleSettings(repo, "project", { useWrapper: null });
    assert.equal(reloaded.gradleSettings(repo, detected, true).wrapper, true);
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test("Gradle wrapper and configured JDK are passed independently", () => {
  const launch = gradleLaunch({ gradleHome: "/Gradle Home", userHome: "/cache home", javaHome: "/Java Home" },
    "darwin", { PATH: "/usr/bin" }, "/repo/gradlew");
  assert.equal(launch.command, "/repo/gradlew");
  assert.equal(launch.env.GRADLE_HOME, undefined);
  assert.equal(launch.env.GRADLE_USER_HOME, "/cache home");
  assert.equal(launch.env.JAVA_HOME, "/Java Home");
  assert.equal(launch.env.PATH, `${join("/Java Home", "bin")}:/usr/bin`);
});

test("Gradle bridge discovers custom tasks and runs a selected APK task through the wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitstudio-gradle-run-"));
  const wrapper = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const marker = '__GITSTUDIO_GRADLE_PROJECTS__' + JSON.stringify([
    { path: ":", name: "root", tasks: ["help", "clean"] },
    { path: ":app", name: "app", tasks: ["assembleDebug", "bundleRelease", "customPackage"] },
  ]);
  try {
    await writeFile(join(root, "settings.gradle"), "include ':app'");
    await writeFile(wrapper, process.platform === "win32"
      ? `@echo off\r\necho ${marker}\r\necho ARGS:%*\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${marker}'\nprintf 'ARGS:%s\\n' "$*"\n`);
    if (process.platform !== "win32") await chmod(wrapper, 0o755);
    const bridge = new GradleBridge(async () => ({
      paths: { gradleHome: "", userHome: join(root, "gradle cache"), javaHome: "" }, wrapper,
    }), () => {});
    const modules = await bridge.modules(root);
    assert.ok(modules.children[0].tasks.includes("customPackage"));
    assert.equal((await bridge.start(root, "assembleDebug", [":app"])).ok, true);
    const deadline = Date.now() + 5000;
    while (bridge.state(root)?.status === "running" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    assert.equal(bridge.state(root)?.status, "success");
    assert.match(bridge.logSnapshot(root).map((entry) => entry.text).join(""), /:app:assembleDebug/);
    bridge.stopAll();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixed Gradle tasks remain selectable when project task discovery fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitstudio-gradle-fallback-"));
  try {
    const bridge = new GradleBridge(async () => ({
      paths: { gradleHome: join(root, "missing"), userHome: "", javaHome: "" },
    }), () => {});
    const tree = await bridge.modules(root);
    assert.equal(tree.path, ":");
    assert.ok(tree.warning);
    assert.deepEqual(buildGradleArgs("bundleRelease", [":"], tree), ["--console=plain", "bundleRelease"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
