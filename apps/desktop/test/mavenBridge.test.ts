import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConsoleDecoder, MavenBridge } from "../src/main/mavenBridge";
import type { MavenLogChunk, MavenTaskState } from "../src/shared/ipc";

test("console output decodes split UTF-8 and Windows GB18030 Chinese", () => {
  const utf8 = new ConsoleDecoder();
  const data = Buffer.from("plain\n中文\n");
  assert.equal(utf8.decode(data.subarray(0, 7)), "plain\n");
  assert.equal(utf8.decode(data.subarray(7)), "中文\n");
  const gb = new ConsoleDecoder();
  assert.equal(gb.decode(Buffer.from([0xD6, 0xD0])), "");
  assert.equal(gb.decode(Buffer.from([0xCE, 0xC4, 0x0A])), "中文\n");
  assert.equal(gb.decode(Buffer.from("UTF-8 中文\n")), "UTF-8 中文\n");
});

test("stop ends Maven and its child in a path with spaces and Chinese", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "maven 中文 project "));
  const home = join(root, "Maven Home");
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(root, "pom.xml"), "<project><artifactId>demo</artifactId></project>");
  const executable = join(home, "bin", "mvn");
  await writeFile(executable, "#!/bin/sh\nsleep 30 &\necho child:$!\nwait\n");
  await chmod(executable, 0o755);
  const logs: MavenLogChunk[] = [];
  const states: MavenTaskState[] = [];
  const bridge = new MavenBridge(() => ({ mavenHome: home, settings: "", javaHome: "" }), (event, data) => {
    if (event === "maven:log") logs.push(data as MavenLogChunk);
    else states.push(data as MavenTaskState);
  });
  try {
    assert.equal((await bridge.start(root, "compile", ["."], false)).ok, true);
    const deadline = Date.now() + 5000;
    while (!logs.some((entry) => entry.text.includes("child:")) && Date.now() < deadline) await delay(25);
    const childPid = Number(/child:(\d+)/.exec(logs.map((entry) => entry.text).join(""))?.[1]);
    assert.ok(childPid > 0, "the Maven script started a child");
    assert.equal(bridge.stop(root), true);
    while (bridge.state(root)?.status === "running" && Date.now() < deadline) await delay(25);
    assert.equal(bridge.state(root)?.status, "stopped");
    let gone = false;
    while (!gone && Date.now() < deadline) {
      try { process.kill(childPid, 0); await delay(25); }
      catch { gone = true; }
    }
    assert.equal(gone, true, "the child process also ended");
    assert.ok(states.some((state) => state.status === "stopped"));
  } finally {
    bridge.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("the spawned command receives module, test and settings arguments as separate values", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "maven 参数 project "));
  const home = join(root, "Maven Home");
  const javaHome = join(root, "Java Home");
  const settings = join(root, "custom settings.xml");
  await mkdir(join(home, "bin"), { recursive: true });
  await mkdir(join(javaHome, "bin"), { recursive: true });
  await mkdir(join(root, "one"));
  await mkdir(join(root, "two"));
  await writeFile(join(root, "pom.xml"), "<project><artifactId>root</artifactId><modules><module>one</module><module>two</module></modules></project>");
  await writeFile(join(root, "one", "pom.xml"), "<project><artifactId>one</artifactId></project>");
  await writeFile(join(root, "two", "pom.xml"), "<project><artifactId>two</artifactId></project>");
  await writeFile(settings, "<settings/>");
  await writeFile(join(javaHome, "bin", "java"), "");
  const executable = join(home, "bin", "mvn");
  await writeFile(executable, "#!/bin/sh\nprintf 'ARG:%s\\n' \"$@\"\nprintf 'JAVA:%s\\n' \"$JAVA_HOME\"\n");
  await chmod(executable, 0o755);
  const bridge = new MavenBridge(() => ({ mavenHome: home, settings, javaHome }), () => {});
  const finished = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (bridge.state(root)?.status === "running" && Date.now() < deadline) await delay(25);
    assert.equal(bridge.state(root)?.status, "success");
  };
  try {
    assert.equal((await bridge.start(root, "compile", ["one"], true)).ok, true);
    await finished();
    const partial = bridge.logSnapshot(root).map((line) => line.text).join("");
    assert.match(partial, /ARG:-pl\nARG:one\n/);
    assert.match(partial, /ARG:-DskipTests\n/);
    assert.match(partial, new RegExp(`ARG:-s\\nARG:${settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.ok(partial.includes(`JAVA:${javaHome}`));
    assert.equal((await bridge.start(root, "clean", [".", "one", "two"], false)).ok, true);
    await finished();
    const all = bridge.logSnapshot(root).map((line) => line.text).join("");
    assert.doesNotMatch(all, /ARG:-pl\n/);
    assert.match(all, /ARG:clean\n/);
  } finally {
    bridge.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
