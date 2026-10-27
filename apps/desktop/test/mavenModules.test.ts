import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverMavenModules } from "../src/main/mavenModules";

test("discovers a nested Maven reactor and warns about missing and repeated modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "maven-modules-"));
  try {
    await mkdir(join(root, "服务", "api"), { recursive: true });
    await writeFile(join(root, "pom.xml"), `<?xml version="1.0"?>
      <project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>parent</artifactId>
      <modules><module>服务</module><module>missing</module></modules></project>`);
    await writeFile(join(root, "服务", "pom.xml"), `<project><artifactId>service</artifactId>
      <modules><module>api</module><module>..</module></modules></project>`);
    await writeFile(join(root, "服务", "api", "pom.xml"), `<project><artifactId>api</artifactId></project>`);
    const tree = await discoverMavenModules(root);
    assert.equal(tree?.artifactId, "parent");
    assert.equal(tree?.path, ".");
    assert.equal(tree?.children[0].path, "服务");
    assert.equal(tree?.children[0].children[0].path, "服务/api");
    assert.match(tree?.children[0].children[1].warning || "", /cycle|referenced/);
    assert.match(tree?.children[1].warning || "", /does not exist/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-module roots work and repositories without pom.xml are empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "maven-single-"));
  try {
    assert.equal(await discoverMavenModules(root), undefined);
    await writeFile(join(root, "pom.xml"), `<project><artifactId>solo</artifactId></project>`);
    assert.deepEqual(await discoverMavenModules(root), { artifactId: "solo", path: ".", children: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
