// The Maven path fields, shared by Settings ▸ Maven (the global scope) and the
// Deploy view's project dialog. Empty means "inherit": a project field falls
// back to the global one, a global field to what main detected on this machine
// (mavenDetect.ts), and each placeholder says which value that is.

import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { toast } from "../dialogs";
import { el } from "../ui";
import type { MavenPaths, MavenScope, MavenSettingsView } from "../../shared/ipc";

const FIELDS: Array<{ key: keyof MavenPaths; label: () => string }> = [
  { key: "mavenHome", label: () => l10n.t("Maven home") },
  { key: "settings", label: () => l10n.t("User settings file") },
  { key: "localRepository", label: () => l10n.t("Local repository") },
  { key: "javaHome", label: () => l10n.t("JDK (JAVA_HOME)") },
];

let fieldSeq = 0;

function button(label: string): HTMLButtonElement {
  const node = el("button", "mini-btn") as HTMLButtonElement;
  node.type = "button";
  node.textContent = label;
  return node;
}

/** One line naming what will run, for the Deploy view's header. */
export function mavenSummary(view: MavenSettingsView): string {
  const e = view.effective;
  const parts = [`Maven: ${view.wrapper ? "mvnw" : e.mavenHome || "mvn (PATH)"}`];
  if (e.javaHome) parts.push(`JDK: ${e.javaHome}`);
  if (e.settings) parts.push(`settings: ${e.settings}`);
  return parts.join("  ·  ");
}

export interface MavenConfigPanel {
  node: HTMLElement;
  /** Lock every control (a Maven task is running). */
  setDisabled(disabled: boolean): void;
  /** Resolves once every queued save has landed. */
  settled(): Promise<void>;
}

export function mavenConfigPanel(
  scope: MavenScope,
  onChange?: (view: MavenSettingsView) => void,
  initial?: MavenSettingsView,
): MavenConfigPanel {
  const node = el("div", "maven-config");
  const fieldsBox = el("div");
  const tools = el("div", "maven-tools");
  const testBtn = button(l10n.t("Test Maven (-v)"));
  tools.append(testBtn);
  const detectBtn = button(l10n.t("Re-detect"));
  if (scope === "global") tools.append(detectBtn);
  const version = el("pre", "maven-version");
  version.hidden = true;
  node.append(fieldsBox, tools, version);

  let view = initial;
  let savePending: Promise<void> = Promise.resolve();
  let locked = false;
  let busy = false;
  const controls = (): Array<HTMLInputElement | HTMLButtonElement> =>
    Array.from(node.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
  const sync = (): void => {
    for (const control of controls()) {
      control.disabled = locked || busy || control.dataset.wrapped === "true";
    }
  };

  const apply = (next: MavenSettingsView): void => {
    view = next;
    paint();
    onChange?.(next);
  };

  const save = (patch: Partial<MavenPaths> & { useWrapper?: boolean | null }): Promise<void> => {
    savePending = savePending.then(async () => {
      try { apply(await host.invoke("maven:saveSettings", { scope, patch })); }
      catch (error) { toast(String(error), "error"); if (view) paint(); }
    });
    return savePending;
  };

  /** What an empty field means, in words. */
  const placeholder = (v: MavenSettingsView, key: keyof MavenPaths): string => {
    if (scope === "project" && key === "mavenHome" && v.wrapper) return l10n.t("Using the Maven wrapper (mvnw)");
    if (scope === "project" && v.global[key]) return l10n.t("Use global: {0}", v.global[key]);
    const found = v.detected.paths[key];
    if (!found) return l10n.t("Not detected — Maven's default");
    const source = v.detected.sources[key];
    return l10n.t("Auto-detected: {0}", source ? `${found} (${source})` : found);
  };

  const paint = (): void => {
    if (!view) return;
    const v = view;
    fieldsBox.replaceChildren();
    if (scope === "project" && v.wrapperAvailable) {
      const wrapLabel = el("label", "settings-check");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = v.wrapper;
      box.addEventListener("change", () => void save({ useWrapper: box.checked }));
      const text = el("div", "settings-check-text");
      const title = el("div", "settings-check-title");
      title.textContent = l10n.t("Use the Maven wrapper (mvnw)");
      const sub = el("div", "settings-sub");
      sub.textContent = l10n.t("This repository ships mvnw; it runs the Maven version the project pins.");
      text.append(title, sub);
      wrapLabel.append(box, text);
      fieldsBox.append(wrapLabel);
    }
    const values = scope === "project" ? v.project : v.global;
    for (const field of FIELDS) {
      const value = values?.[field.key] ?? "";
      const row = el("div", "maven-config-row");
      const label = el("label", "settings-field-label") as HTMLLabelElement;
      label.textContent = field.label();
      const input = document.createElement("input");
      input.className = "settings-input";
      input.id = `gs-maven-${++fieldSeq}`;
      label.htmlFor = input.id;
      input.value = value;
      input.placeholder = placeholder(v, field.key);
      input.title = input.placeholder;
      input.spellcheck = false;
      const pick = button(l10n.t("Browse…"));
      const reset = button(l10n.t("Reset"));
      reset.hidden = !value;
      // The wrapper decides which Maven runs; Maven home has no say then.
      if (scope === "project" && field.key === "mavenHome" && v.wrapper) {
        input.dataset.wrapped = pick.dataset.wrapped = reset.dataset.wrapped = "true";
      }
      input.addEventListener("change", () => void save({ [field.key]: input.value }));
      pick.addEventListener("click", () => void host.invoke("maven:pickPath", { kind: field.key }).then((picked) => {
        if (picked) void save({ [field.key]: picked });
      }));
      reset.addEventListener("click", () => void save({ [field.key]: "" }));
      const box = el("div", "maven-config-field");
      box.append(label, input);
      row.append(box, pick, reset);
      fieldsBox.append(row);
    }
    const hint = el("div", "settings-sub");
    hint.textContent = scope === "project"
      ? l10n.t("Empty fields use the global Maven settings (Settings ▸ Maven).")
      : l10n.t("Empty fields use what was detected on this computer, the way IntelliJ IDEA does.");
    fieldsBox.append(hint);
    sync();
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    busy = true;
    sync();
    try { await work(); }
    finally { busy = false; sync(); }
  };

  testBtn.addEventListener("click", () => void run(async () => {
    await savePending;
    version.hidden = false;
    version.textContent = l10n.t("Running mvn -v…");
    try {
      const result = await host.invoke("maven:test", { scope });
      version.textContent = result.output || (result.ok ? l10n.t("Maven is available") : l10n.t("Maven could not start"));
    } catch (error) { version.textContent = String(error); }
  }));
  detectBtn.addEventListener("click", () => void run(async () => {
    await savePending;
    try { apply(await host.invoke("maven:detect", { scope })); }
    catch (error) { toast(String(error), "error"); }
  }));

  if (view) paint();
  else {
    void host.invoke("maven:settings", { scope }).then(apply, (error) => toast(String(error), "error"));
  }

  return {
    node,
    setDisabled(disabled) { locked = disabled; sync(); },
    settled: () => savePending,
  };
}
