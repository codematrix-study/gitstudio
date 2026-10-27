import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMaven, localRepositoryIn, parseShellEnv, type MavenDetectDeps } from "../src/main/mavenDetect";

/** A fake machine: `files` exist, `links` resolve, `contents` read. */
function machine(o: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  files?: string[];
  links?: Record<string, string>;
  contents?: Record<string, string>;
  javaHomeTool?: string;
}): MavenDetectDeps {
  const files = new Set([...(o.files ?? []), ...Object.keys(o.contents ?? {})]);
  return {
    platform: o.platform ?? "darwin",
    home: o.platform === "win32" ? "C:\\Users\\me" : "/Users/me",
    env: o.env ?? {},
    exists: (p) => files.has(p),
    realpath: (p) => o.links?.[p] ?? p,
    readFile: (p) => o.contents?.[p],
    javaHomeTool: o.javaHomeTool,
  };
}

test("MAVEN_HOME wins over M2_HOME and PATH", () => {
  const found = detectMaven(machine({
    env: { MAVEN_HOME: "/opt/maven", M2_HOME: "/opt/m2", PATH: "/usr/local/bin" },
    files: ["/opt/maven/bin/mvn", "/opt/m2/bin/mvn", "/usr/local/bin/mvn"],
  }));
  assert.equal(found.paths.mavenHome, "/opt/maven");
  assert.equal(found.sources.mavenHome, "MAVEN_HOME");
});

test("M2_HOME is used when MAVEN_HOME is missing or wrong", () => {
  const found = detectMaven(machine({
    env: { MAVEN_HOME: "/nowhere", M2_HOME: "/opt/m2" },
    files: ["/opt/m2/bin/mvn"],
  }));
  assert.equal(found.paths.mavenHome, "/opt/m2");
  assert.equal(found.sources.mavenHome, "M2_HOME");
});

test("Homebrew's mvn resolves through the symlink to libexec, even off a GUI PATH", () => {
  const found = detectMaven(machine({
    env: { PATH: "/usr/bin:/bin" },
    files: [
      "/opt/homebrew/bin/mvn",
      "/opt/homebrew/Cellar/maven/3.9.9/bin/mvn",
      "/opt/homebrew/Cellar/maven/3.9.9/libexec/bin/mvn",
      "/opt/homebrew/Cellar/maven/3.9.9/libexec/conf/settings.xml",
    ],
    links: { "/opt/homebrew/bin/mvn": "/opt/homebrew/Cellar/maven/3.9.9/bin/mvn" },
  }));
  assert.equal(found.paths.mavenHome, "/opt/homebrew/Cellar/maven/3.9.9/libexec");
  assert.equal(found.sources.mavenHome, "PATH");
  assert.equal(found.paths.settings, "/opt/homebrew/Cellar/maven/3.9.9/libexec/conf/settings.xml");
  assert.equal(found.sources.settings, "conf");
});

test("SDKMAN is the last resort for Maven and Java", () => {
  const found = detectMaven(machine({
    files: ["/Users/me/.sdkman/candidates/maven/current/bin/mvn", "/Users/me/.sdkman/candidates/java/current/bin/java"],
  }));
  assert.equal(found.sources.mavenHome, "SDKMAN");
  assert.equal(found.paths.javaHome, "/Users/me/.sdkman/candidates/java/current");
  assert.equal(found.sources.javaHome, "SDKMAN");
});

test("~/.m2/settings.xml is the user settings and its <localRepository> is expanded", () => {
  const found = detectMaven(machine({
    env: { MAVEN_HOME: "/opt/maven", REPO_ROOT: "/data" },
    files: ["/opt/maven/bin/mvn"],
    contents: {
      "/Users/me/.m2/settings.xml": `<?xml version="1.0"?>
        <settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"><localRepository>\${user.home}/repo</localRepository></settings>`,
      "/opt/maven/conf/settings.xml": "<settings><localRepository>/ignored</localRepository></settings>",
    },
  }));
  assert.equal(found.paths.settings, "/Users/me/.m2/settings.xml");
  assert.equal(found.sources.settings, "~/.m2");
  assert.equal(found.paths.localRepository, "/Users/me/repo");
  assert.equal(found.sources.localRepository, "settings.xml");
  assert.equal(localRepositoryIn("<settings><localRepository>${env.REPO_ROOT}/m2</localRepository></settings>", "/h", { REPO_ROOT: "/data" }), "/data/m2");
  assert.equal(localRepositoryIn("<settings><!-- <localRepository>/x</localRepository> --></settings>", "/h", {}), undefined);
  assert.equal(localRepositoryIn("not xml", "/h", {}), undefined);
});

test("with nothing installed, only the default local repository is known", () => {
  const found = detectMaven(machine({}));
  assert.deepEqual(found.paths, { mavenHome: "", settings: "", localRepository: "/Users/me/.m2/repository", javaHome: "" });
  assert.equal(found.sources.localRepository, "default");
});

test("macOS's java_home answers before PATH, and its /usr/bin/java stub is no JDK", () => {
  const jdk = "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home";
  const found = detectMaven(machine({ javaHomeTool: `${jdk}\n`, files: [`${jdk}/bin/java`] }));
  assert.equal(found.paths.javaHome, jdk);
  assert.equal(found.sources.javaHome, "java_home");
  const stub = detectMaven(machine({ env: { PATH: "/usr/bin" }, files: ["/usr/bin/java"] }));
  assert.equal(stub.paths.javaHome, "");
});

test("Windows finds mvn.cmd on PATH and JAVA_HOME's java.exe", () => {
  const found = detectMaven(machine({
    platform: "win32",
    env: { Path: "C:\\Windows;C:\\tools\\apache-maven-3.9.9\\bin", JAVA_HOME: "C:\\Java\\jdk-21" },
    files: ["C:\\tools\\apache-maven-3.9.9\\bin\\mvn.cmd", "C:\\Java\\jdk-21\\bin\\java.exe"],
  }));
  assert.equal(found.paths.mavenHome, "C:\\tools\\apache-maven-3.9.9");
  assert.equal(found.paths.javaHome, "C:\\Java\\jdk-21");
  assert.equal(found.paths.localRepository, "C:\\Users\\me\\.m2\\repository");
});

test("the login shell's variables are read between the marks only", () => {
  const out = "motd noise\n__GITSTUDIO_ENV__\nPATH=/opt/homebrew/bin:/usr/bin\nMAVEN_HOME=/opt/maven\nSECRET=x\n__GITSTUDIO_ENV__\nbye\n";
  assert.deepEqual(parseShellEnv(out), { PATH: "/opt/homebrew/bin:/usr/bin", MAVEN_HOME: "/opt/maven" });
  assert.deepEqual(parseShellEnv("no marks"), {});
});
