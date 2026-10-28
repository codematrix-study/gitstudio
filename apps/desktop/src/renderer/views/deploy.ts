import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import { toast } from "../dialogs";
import { el, emptyState } from "../ui";
import type { SectionRender } from "./common";
import { renderGradleDeploy } from "./gradleDeploy";
import { renderMavenDeploy } from "./mavenDeploy";

type Manager = "maven" | "gradle";

export const renderDeploy: SectionRender = (wrap) => { void mount(wrap); };

async function mount(wrap: HTMLElement): Promise<void> {
  const shell = el("div", "deploy-page");
  const tabs = el("div", "deploy-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", l10n.t("Build manager"));
  const pane = el("div", "deploy-pane");
  shell.append(tabs, pane);
  wrap.replaceChildren(shell);
  let detected: { maven: boolean; gradle: boolean };
  try { detected = await host.invoke("deploy:detect", undefined); }
  catch (error) { pane.replaceChildren(emptyState(l10n.t("Build manager detection failed"), String(error))); return; }
  if (!wrap.isConnected) return;
  const buttons = new Map<Manager, HTMLButtonElement>();
  const select = (manager: Manager, notify = false): void => {
    for (const [name, button] of buttons) {
      button.classList.toggle("active", name === manager);
      button.setAttribute("aria-selected", String(name === manager));
    }
    pane.replaceChildren();
    if (!detected[manager]) {
      const name = manager === "maven" ? "Maven" : "Gradle";
      const message = l10n.t("No {0} project was recognized in this repository.", name);
      pane.append(emptyState(l10n.t("Project not recognized"), message));
      if (notify) toast(message, "error");
      return;
    }
    const content = el("div", "deploy-content");
    pane.append(content);
    if (manager === "maven") renderMavenDeploy(content, () => {});
    else renderGradleDeploy(content, () => {});
  };
  for (const manager of ["maven", "gradle"] as const) {
    const button = el("button", "deploy-tab") as HTMLButtonElement;
    button.type = "button";
    button.textContent = manager === "maven" ? "Maven" : "Gradle";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => select(manager, true));
    tabs.append(button);
    buttons.set(manager, button);
  }
  select(detected.gradle ? "gradle" : "maven");
}
