import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import * as l10n from "@vscode/l10n";
import type { MavenModule } from "../shared/ipc";

function child(parent: Element, name: string): Element | undefined {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && ((node as Element).localName || node.nodeName) === name) return node as Element;
  }
  return undefined;
}

function children(parent: Element, name: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && ((node as Element).localName || node.nodeName) === name) result.push(node as Element);
  }
  return result;
}

function parsePom(xml: string): { artifactId: string; modules: string[] } {
  if (xml.length > 2_000_000) throw new Error(l10n.t("pom.xml is too large"));
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length || !doc.documentElement || doc.documentElement.localName !== "project") {
    throw new Error(errors[0] || l10n.t("Invalid Maven project XML"));
  }
  const project = doc.documentElement;
  return {
    artifactId: child(project, "artifactId")?.textContent?.trim() || "",
    modules: children(child(project, "modules") || project, "module")
      .map((module) => module.textContent?.trim() || "")
      .filter(Boolean),
  };
}

/** Recursively read the reactor described by the opened repository's root POM. */
export async function discoverMavenModules(root: string): Promise<MavenModule | undefined> {
  const base = resolve(root);
  const seen = new Set<string>();
  const walk = async (dir: string): Promise<MavenModule> => {
    const path = relative(base, dir).split(sep).join("/") || ".";
    const node: MavenModule = { artifactId: basename(dir), path, children: [] };
    let canonical: string;
    try {
      canonical = await realpath(dir);
    } catch {
      node.warning = l10n.t("Module directory does not exist");
      return node;
    }
    if (seen.has(canonical)) {
      node.warning = l10n.t("Module is referenced more than once or forms a cycle");
      return node;
    }
    seen.add(canonical);
    let xml: string;
    try {
      xml = await readFile(join(dir, "pom.xml"), "utf8");
    } catch {
      node.warning = l10n.t("pom.xml does not exist or cannot be read");
      return node;
    }
    try {
      const pom = parsePom(xml);
      node.artifactId = pom.artifactId || node.artifactId;
      for (const modulePath of pom.modules) {
        // Maven permits .. within a reactor; keep the path relative to the
        // opened root, and let realpath/seen prevent symlink loops as well.
        node.children.push(await walk(resolve(dirname(join(dir, "pom.xml")), modulePath)));
      }
    } catch (error) {
      node.warning = error instanceof Error ? error.message : l10n.t("Invalid pom.xml");
    }
    return node;
  };
  try {
    await readFile(join(base, "pom.xml"));
  } catch {
    return undefined;
  }
  return walk(base);
}
