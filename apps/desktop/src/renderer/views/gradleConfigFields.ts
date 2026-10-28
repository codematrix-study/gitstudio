import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { toast } from "../dialogs";
import { el } from "../ui";
import type { GradlePaths, GradleScope, GradleSettingsView } from "../../shared/ipc";

const FIELDS: Array<{ key: keyof GradlePaths; label: () => string }> = [
  { key: "gradleHome", label: () => l10n.t("Gradle home") },
  { key: "userHome", label: () => l10n.t("Gradle user home") },
  { key: "javaHome", label: () => l10n.t("JDK (JAVA_HOME)") },
];
let fieldSeq = 0;

function button(label: string): HTMLButtonElement {
  const node = el("button", "mini-btn") as HTMLButtonElement;
  node.type = "button";
  node.textContent = label;
  return node;
}

export function gradleSummary(view: GradleSettingsView): string {
  const e = view.effective;
  const parts = [`Gradle: ${view.wrapper ? "gradlew" : e.gradleHome || "gradle (PATH)"}`];
  if (e.javaHome) parts.push(`JDK: ${e.javaHome}`);
  if (e.userHome) parts.push(`GRADLE_USER_HOME: ${e.userHome}`);
  return parts.join("  ·  ");
}

export interface GradleConfigPanel {
  node: HTMLElement;
  setDisabled(disabled: boolean): void;
  settled(): Promise<void>;
}

export function gradleConfigPanel(
  scope: GradleScope,
  onChange?: (view: GradleSettingsView) => void,
  initial?: GradleSettingsView,
): GradleConfigPanel {
  const node = el("div", "maven-config");
  const fieldsBox = el("div");
  const tools = el("div", "maven-tools");
  const testBtn = button(l10n.t("Test Gradle (-v)"));
  const detectBtn = button(l10n.t("Re-detect"));
  tools.append(testBtn);
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
    for (const control of controls()) control.disabled = locked || busy || control.dataset.wrapped === "true";
  };
  const apply = (next: GradleSettingsView): void => { view = next; paint(); onChange?.(next); };
  const save = (patch: Partial<GradlePaths> & { useWrapper?: boolean | null }): Promise<void> => {
    savePending = savePending.then(async () => {
      try { apply(await host.invoke("gradle:saveSettings", { scope, patch })); }
      catch (error) { toast(String(error), "error"); if (view) paint(); }
    });
    return savePending;
  };
  const placeholder = (v: GradleSettingsView, key: keyof GradlePaths): string => {
    if (scope === "project" && key === "gradleHome" && v.wrapper) return l10n.t("Using the Gradle wrapper (gradlew)");
    if (scope === "project" && v.global[key]) return l10n.t("Use global: {0}", v.global[key]);
    const found = v.detected.paths[key];
    if (!found) return l10n.t("Not detected");
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
      title.textContent = l10n.t("Use the Gradle wrapper (gradlew)");
      const sub = el("div", "settings-sub");
      sub.textContent = l10n.t("This repository ships gradlew; it runs the Gradle version the project pins.");
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
      input.id = `gs-gradle-${++fieldSeq}`;
      label.htmlFor = input.id;
      input.value = value;
      input.placeholder = placeholder(v, field.key);
      input.title = input.placeholder;
      input.spellcheck = false;
      const pick = button(l10n.t("Browse…"));
      const reset = button(l10n.t("Reset"));
      reset.hidden = !value;
      if (scope === "project" && field.key === "gradleHome" && v.wrapper) {
        input.dataset.wrapped = pick.dataset.wrapped = reset.dataset.wrapped = "true";
      }
      input.addEventListener("change", () => void save({ [field.key]: input.value }));
      pick.addEventListener("click", () => void host.invoke("gradle:pickPath", { kind: field.key }).then((picked) => {
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
      ? l10n.t("Empty fields use the global Gradle settings (Settings ▸ Gradle).")
      : l10n.t("Empty fields use what was detected on this computer.");
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
    version.textContent = l10n.t("Running gradle -v…");
    try {
      const result = await host.invoke("gradle:test", { scope });
      version.textContent = result.output || (result.ok ? l10n.t("Gradle is available") : l10n.t("Gradle could not start"));
    } catch (error) { version.textContent = String(error); }
  }));
  detectBtn.addEventListener("click", () => void run(async () => {
    await savePending;
    try { apply(await host.invoke("gradle:detect", { scope })); }
    catch (error) { toast(String(error), "error"); }
  }));
  if (view) paint();
  else void host.invoke("gradle:settings", { scope }).then(apply, (error) => toast(String(error), "error"));
  return { node, setDisabled(disabled) { locked = disabled; sync(); }, settled: () => savePending };
}
