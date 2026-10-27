import * as l10n from "@vscode/l10n";
import { host, currentSession } from "../bridge";
import { confirmDialog, toast } from "../dialogs";
import { copyText, el, emptyState, settingsCard } from "../ui";
import type { MavenGoal, MavenLogChunk, MavenModule, MavenPaths, MavenSettingsView, MavenTaskState } from "../../shared/ipc";
import type { SectionRender } from "./common";

const fields: Array<{ key: keyof MavenPaths; label: string }> = [
  { key: "mavenHome", label: "MAVEN_HOME" },
  { key: "settings", label: "settings.xml" },
  { key: "javaHome", label: "JAVA_HOME" },
];

function button(label: string, className = "mini-btn"): HTMLButtonElement {
  const node = el("button", className) as HTMLButtonElement;
  node.type = "button";
  node.textContent = label;
  return node;
}

function formatDuration(state: MavenTaskState): string {
  return `${Math.floor(((state.endedAt || Date.now()) - state.startedAt) / 1000)}s`;
}

export const renderMavenDeploy: SectionRender = (wrap) => { void mount(wrap); };

async function mount(wrap: HTMLElement): Promise<void> {
  const root = currentSession()?.root;
  if (!root) return;
  const view = el("div", "maven-page");
  const title = el("h1", "maven-title");
  title.textContent = l10n.t("Deploy");
  view.append(title);

  const moduleCard = settingsCard(l10n.t("Maven modules"), "package");
  const moduleTools = el("div", "maven-tools");
  const allBtn = button(l10n.t("Select all"));
  const noneBtn = button(l10n.t("Select none"));
  const refreshBtn = button(l10n.t("Refresh"));
  moduleTools.append(allBtn, noneBtn, refreshBtn);
  const moduleList = el("div", "maven-modules");
  moduleCard.body.append(moduleTools, moduleList);
  view.append(moduleCard.card);

  const operationCard = settingsCard(l10n.t("Maven actions"), "play");
  const actionRow = el("div", "maven-actions");
  const actions = (["clean", "compile", "deploy"] as const).map((goal) => {
    const label = goal === "clean" ? "Clean" : goal === "compile" ? "Compile" : "Deploy";
    const b = button(label, goal === "deploy" ? "btn-primary" : "btn");
    actionRow.append(b);
    return { goal, button: b };
  });
  const stopBtn = button(l10n.t("Stop"), "btn-danger");
  stopBtn.hidden = true;
  actionRow.append(stopBtn);
  const skipLabel = el("label", "settings-check");
  const skip = document.createElement("input");
  skip.type = "checkbox";
  skipLabel.append(skip, document.createTextNode(l10n.t("Skip tests")));
  const hint = el("div", "settings-sub");
  hint.textContent = l10n.t("Select a module to run Maven.");
  operationCard.body.append(actionRow, skipLabel, hint);
  const configTitle = el("h2", "maven-config-heading");
  configTitle.textContent = l10n.t("Maven configuration");
  const settingsContent = el("div", "maven-config");
  operationCard.body.append(configTitle, settingsContent);
  view.append(operationCard.card);

  const logCard = settingsCard(l10n.t("Maven log"), "output");
  const logTools = el("div", "maven-tools");
  const clearBtn = button(l10n.t("Clear"));
  const copyBtn = button(l10n.t("Copy"));
  const status = el("div", "maven-status");
  logTools.append(clearBtn, copyBtn, status);
  const logScroll = el("div", "maven-log-scroll");
  const logLines = el("div", "maven-log-lines");
  logScroll.append(logLines);
  logCard.body.append(logTools, logScroll);
  view.append(logCard.card);
  wrap.replaceChildren(view);

  let tree: MavenModule | undefined;
  let config: MavenSettingsView | undefined;
  let task: MavenTaskState | undefined;
  let testing = false;
  let savePending: Promise<void> = Promise.resolve();
  let taskId = "";
  let seenSeq = 0;
  let initializing = true;
  let follow = true;
  const selected = new Set<string>();
  const available = new Map<string, MavenModule>();
  const queued: MavenLogChunk[] = [];
  const carry: Record<MavenLogChunk["stream"], string> = { stdout: "", stderr: "", system: "" };
  let frame = 0;

  const updateButtons = (): void => {
    const running = task?.status === "running";
    const busy = running || testing;
    for (const action of actions) {
      action.button.disabled = busy || selected.size === 0;
      action.button.title = selected.size === 0 ? l10n.t("Select a module") : "";
    }
    stopBtn.hidden = !running;
    stopBtn.disabled = !running;
    allBtn.disabled = noneBtn.disabled = refreshBtn.disabled = busy;
    skip.disabled = busy;
    moduleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((box) => {
      box.disabled = busy || box.dataset.warning === "true";
    });
    settingsContent.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => {
      control.disabled = busy;
    });
    hint.hidden = selected.size > 0;
  };

  const updateStatus = (): void => {
    if (!task) { status.textContent = l10n.t("No Maven task yet"); return; }
    const label = task.status === "running" ? l10n.t("Running")
      : task.status === "success" ? l10n.t("Succeeded")
      : task.status === "stopped" ? l10n.t("Stopped")
      : l10n.t("Failed (exit code {0})", task.exitCode ?? "?");
    status.textContent = `${label} · ${new Date(task.startedAt).toLocaleTimeString()} · ${formatDuration(task)}`;
  };

  const clearLog = (): void => {
    logLines.replaceChildren();
    carry.stdout = carry.stderr = carry.system = "";
    queued.length = 0;
    follow = true;
  };

  const drain = (): void => {
    frame = 0;
    const rows: Array<{ stream: MavenLogChunk["stream"]; line: string }> = [];
    for (const chunk of queued.splice(0).sort((a, b) => a.seq - b.seq)) {
      if (chunk.seq <= seenSeq || (taskId && chunk.id !== taskId)) continue;
      seenSeq = chunk.seq;
      const parts = (carry[chunk.stream] + chunk.text).split(/\r?\n/);
      carry[chunk.stream] = parts.pop() || "";
      for (const line of parts) rows.push({ stream: chunk.stream, line });
      if (rows.length > 30000) rows.splice(0, rows.length - 20000);
    }
    if (task && task.status !== "running") {
      for (const stream of ["stdout", "stderr", "system"] as const) {
        if (!carry[stream]) continue;
        rows.push({ stream, line: carry[stream] });
        carry[stream] = "";
      }
    }
    if (rows.length > 20000) rows.splice(0, rows.length - 20000);
    const excess = Math.max(0, logLines.childElementCount + rows.length - 20000);
    for (let i = 0; i < excess && logLines.firstChild; i++) logLines.firstChild.remove();
    const fragment = document.createDocumentFragment();
    for (const { stream, line } of rows) {
      const row = el("div", `maven-log-line maven-${stream}`);
      row.textContent = line || " ";
      fragment.append(row);
    }
    logLines.append(fragment);
    if (follow) logScroll.scrollTop = logScroll.scrollHeight;
  };

  const queueLog = (chunk: MavenLogChunk): void => {
    if (chunk.root !== root || chunk.seq <= seenSeq) return;
    queued.push(chunk);
    if (!initializing && !frame) frame = requestAnimationFrame(drain);
  };

  logScroll.addEventListener("scroll", () => {
    follow = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 48;
  });
  clearBtn.addEventListener("click", clearLog);
  copyBtn.addEventListener("click", () => void copyText(Array.from(logLines.children, (row) => row.textContent || "").join("\n")));

  const paintModules = (): void => {
    available.clear();
    moduleList.replaceChildren();
    if (!tree) {
      moduleList.append(emptyState(l10n.t("No pom.xml"), l10n.t("This repository has no pom.xml at its root.")));
      return;
    }
    const build = (node: MavenModule): HTMLElement => {
      const item = el("li", "maven-module");
      const label = el("label", "maven-module-label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.disabled = !!node.warning;
      if (node.warning) check.dataset.warning = "true";
      check.checked = selected.has(node.path);
      if (!node.warning) available.set(node.path, node);
      check.addEventListener("change", () => {
        if (check.checked) selected.add(node.path);
        else selected.delete(node.path);
        updateButtons();
      });
      const name = el("span");
      name.textContent = node.artifactId;
      const path = el("small");
      path.textContent = node.path;
      label.append(check, name, path);
      item.append(label);
      if (node.warning) {
        const warning = el("div", "maven-warning");
        warning.textContent = node.warning;
        item.append(warning);
      }
      if (node.children.length) {
        const list = el("ul", "maven-tree");
        for (const child of node.children) list.append(build(child));
        item.append(list);
      }
      return item;
    };
    const list = el("ul", "maven-tree");
    list.append(build(tree));
    moduleList.append(list);
    for (const path of selected) if (!available.has(path)) selected.delete(path);
    updateButtons();
  };

  const refreshModules = async (): Promise<void> => {
    refreshBtn.disabled = true;
    try { tree = await host.invoke("maven:modules", undefined); paintModules(); }
    catch (error) { toast(String(error), "error"); }
    finally { refreshBtn.disabled = false; updateButtons(); }
  };
  allBtn.addEventListener("click", () => {
    for (const path of available.keys()) selected.add(path);
    paintModules();
  });
  noneBtn.addEventListener("click", () => { selected.clear(); paintModules(); });
  refreshBtn.addEventListener("click", () => void refreshModules());

  const paintSettings = (): void => {
    if (!config) return;
    settingsContent.replaceChildren();
    for (const scope of ["global", "project"] as const) {
      const heading = el("h3", "maven-config-heading");
      heading.textContent = scope === "global" ? l10n.t("Global settings") : l10n.t("Project overrides");
      settingsContent.append(heading);
      for (const field of fields) {
        const row = el("div", "maven-config-row");
        const label = el("label", "settings-field-label");
        label.textContent = field.label;
        const input = document.createElement("input");
        input.className = "settings-input";
        input.value = config[scope][field.key];
        input.placeholder = scope === "project" ? l10n.t("Use global setting") : l10n.t("Use system environment");
        label.append(input);
        const pick = button(l10n.t("Browse…"));
        const save = (value: string): Promise<void> => {
          savePending = savePending.then(async () => {
            try {
              config = await host.invoke("maven:saveSettings", { scope, patch: { [field.key]: value } });
              paintSettings();
            } catch (error) { toast(String(error), "error"); }
          });
          return savePending;
        };
        input.addEventListener("change", () => void save(input.value));
        pick.addEventListener("click", () => void host.invoke("maven:pickPath", { kind: field.key }).then((value) => {
          if (value) void save(value);
        }));
        row.append(label, pick);
        settingsContent.append(row);
      }
    }
    const effective = el("div", "settings-sub");
    effective.textContent = l10n.t("Empty project fields use global settings; empty global fields use the system environment.");
    settingsContent.append(effective);
    const testBtn = button(l10n.t("Test Maven (-v)"));
    const version = el("pre", "maven-version");
    testBtn.addEventListener("click", () => void (async () => {
      testing = true;
      updateButtons();
      try {
        await savePending;
        const result = await host.invoke("maven:test", undefined);
        version.textContent = result.output || (result.ok ? l10n.t("Maven is available") : l10n.t("Maven could not start"));
      } catch (error) { version.textContent = String(error); }
      finally { testing = false; updateButtons(); }
    })());
    settingsContent.append(testBtn, version);
    updateButtons();
  };

  const applyTask = (next: MavenTaskState): void => {
    if (next.root !== root) return;
    if (task && next.startedAt < task.startedAt) return;
    if (taskId && taskId !== next.id) { clearLog(); seenSeq = 0; }
    taskId = next.id;
    task = next;
    updateStatus();
    updateButtons();
    if (next.status !== "running" && !frame) frame = requestAnimationFrame(drain);
  };
  stopBtn.addEventListener("click", () => void host.invoke("maven:stop", undefined));
  for (const { goal, button: action } of actions) {
    action.addEventListener("click", () => void (async () => {
      if (!selected.size || task?.status === "running") return;
      await savePending;
      if (goal === "deploy") {
        const names = [...selected].map((path) => `${available.get(path)?.artifactId || path} (${path})`).join("\n");
        const settings = config?.effective.settings || l10n.t("Maven default settings");
        const confirmed = await confirmDialog({
          title: l10n.t("Deploy Maven modules?"),
          message: `${l10n.t("Modules to deploy:")}\n${names}\n\nsettings.xml: ${settings}`,
          confirmLabel: l10n.t("Deploy"),
        });
        if (!confirmed) return;
      }
      try {
        const result = await host.invoke("maven:start", { goal, paths: [...selected], skipTests: skip.checked });
        if (!result.ok) toast(result.message || l10n.t("Maven could not start"), "error");
        else if (result.state) applyTask(result.state);
      } catch (error) { toast(String(error), "error"); }
    })());
  }

  const offLog = host.on("maven:log", queueLog);
  const offState = host.on("maven:state", applyTask);
  const observer = new MutationObserver(() => {
    if (wrap.isConnected) return;
    offLog(); offState(); observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const ticker = window.setInterval(() => {
    if (!wrap.isConnected) { clearInterval(ticker); return; }
    if (task?.status === "running") updateStatus();
  }, 1000);

  let modules: MavenModule | undefined;
  let settings: MavenSettingsView;
  let current: MavenTaskState | undefined;
  let logs: MavenLogChunk[];
  try {
    [modules, settings, current, logs] = await Promise.all([
      host.invoke("maven:modules", undefined),
      host.invoke("maven:settings", undefined),
      host.invoke("maven:state", undefined),
      host.invoke("maven:logs", undefined),
    ]);
  } catch (error) {
    if (wrap.isConnected) toast(String(error), "error");
    return;
  }
  if (!wrap.isConnected) return;
  tree = modules;
  config = settings;
  paintModules();
  paintSettings();
  if (current) applyTask(current);
  for (const log of logs) queueLog(log);
  initializing = false;
  if (queued.length && !frame) frame = requestAnimationFrame(drain);
  updateStatus();
  updateButtons();
}
