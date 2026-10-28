import * as l10n from "@vscode/l10n";
import { host, currentSession } from "../bridge";
import { confirmDialog, openModal, toast } from "../dialogs";
import { copyText, el, emptyState, glyph, settingsCard } from "../ui";
import type { MavenLogChunk, MavenModule, MavenSettingsView, MavenTaskState } from "../../shared/ipc";
import { normalizePath } from "../../shared/repoGrouping";
import type { SectionRender } from "./common";
import { mavenConfigPanel, mavenSummary, type MavenConfigPanel } from "./mavenConfigFields";

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
  const normalizedRoot = normalizePath(root);
  const view = el("div", "maven-page");
  const header = el("div", "maven-header");
  const heading = el("div", "maven-heading");
  const title = el("h1", "maven-title");
  title.textContent = l10n.t("Deploy");
  const summary = el("div", "maven-summary");
  heading.append(title, summary);
  const gearBtn = el("button", "icon-btn maven-gear") as HTMLButtonElement;
  gearBtn.type = "button";
  gearBtn.append(glyph("gear"));
  gearBtn.title = l10n.t("Project Maven settings");
  gearBtn.setAttribute("aria-label", l10n.t("Project Maven settings"));
  header.append(heading, gearBtn);
  view.append(header);

  const moduleCard = settingsCard(l10n.t("Maven modules"), "package");
  const moduleTools = el("div", "maven-tools");
  const moduleFilter = document.createElement("input");
  moduleFilter.className = "settings-input maven-filter";
  moduleFilter.type = "search";
  moduleFilter.placeholder = l10n.t("Filter…");
  moduleFilter.setAttribute("aria-label", `${l10n.t("Filter")} ${l10n.t("Maven modules")}`);
  const allBtn = button(l10n.t("Select all"));
  const noneBtn = button(l10n.t("Select none"));
  const refreshBtn = button(l10n.t("Refresh"));
  moduleTools.append(moduleFilter, allBtn, noneBtn, refreshBtn);
  const moduleList = el("div", "maven-modules");
  moduleCard.body.append(moduleTools, moduleList);

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
  const main = el("div", "maven-main");
  main.append(moduleCard.card, operationCard.card);
  view.append(main);

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
  let panel: MavenConfigPanel | undefined;
  let taskId = "";
  let seenSeq = 0;
  let initializing = true;
  let follow = true;
  const selected = new Set<string>();
  const available = new Map<string, MavenModule>();
  const visibleSelectable = new Set<string>();
  const queued: MavenLogChunk[] = [];
  const carry: Record<MavenLogChunk["stream"], string> = { stdout: "", stderr: "", system: "" };
  let frame = 0;

  const updateButtons = (): void => {
    const running = task?.status === "running";
    const busy = running;
    for (const action of actions) {
      action.button.disabled = busy || selected.size === 0;
      action.button.title = selected.size === 0 ? l10n.t("Select a module") : "";
    }
    stopBtn.hidden = !running;
    stopBtn.disabled = !running;
    allBtn.disabled = noneBtn.disabled = refreshBtn.disabled = busy;
    skip.disabled = busy;
    moduleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((box) => {
      box.disabled = busy || box.dataset.warning === "true" || box.dataset.context === "true";
    });
    gearBtn.disabled = busy;
    panel?.setDisabled(busy);
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
    if (normalizePath(chunk.root) !== normalizedRoot || chunk.seq <= seenSeq) return;
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
    visibleSelectable.clear();
    moduleList.replaceChildren();
    if (!tree) {
      moduleList.append(emptyState(l10n.t("No pom.xml"), l10n.t("This repository has no pom.xml at its root.")));
      updateButtons();
      return;
    }
    const query = moduleFilter.value.trim().toLowerCase();
    const build = (node: MavenModule): HTMLElement | undefined => {
      if (!node.warning) available.set(node.path, node);
      const children = node.children.map(build).filter((child): child is HTMLElement => !!child);
      const matches = !query || node.artifactId.toLowerCase().includes(query)
        || node.path.toLowerCase().includes(query);
      if (!matches && !children.length) return undefined;
      if (matches && !node.warning) visibleSelectable.add(node.path);
      const item = el("li", "maven-module");
      const label = el("label", "maven-module-label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.disabled = !!node.warning || (!!query && !matches);
      check.hidden = !!query && !matches;
      if (node.warning) check.dataset.warning = "true";
      if (query && !matches) check.dataset.context = "true";
      check.checked = selected.has(node.path);
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
      if (children.length) {
        const list = el("ul", "maven-tree");
        list.append(...children);
        item.append(list);
      }
      return item;
    };
    const list = el("ul", "maven-tree");
    const rootItem = build(tree);
    if (rootItem) { list.append(rootItem); moduleList.append(list); }
    else moduleList.append(emptyState(l10n.t("No results"), l10n.t("Nothing matches “{0}”.", moduleFilter.value.trim())));
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
    for (const path of visibleSelectable) selected.add(path);
    paintModules();
  });
  noneBtn.addEventListener("click", () => { selected.clear(); paintModules(); });
  refreshBtn.addEventListener("click", () => void refreshModules());
  moduleFilter.addEventListener("input", paintModules);

  const applyConfig = (next: MavenSettingsView): void => {
    config = next;
    summary.textContent = mavenSummary(next);
    summary.title = summary.textContent;
  };

  /** The gear: this repository's overrides, in a dialog. */
  const openProjectSettings = (): void => {
    if (task?.status === "running") return;
    const card = el("div", "modal-card modal-card-form maven-settings-dialog");
    const head = el("div", "maven-dialog-head");
    const h = el("div", "modal-title");
    h.textContent = l10n.t("Project Maven settings");
    const closeBtn = el("button", "icon-btn") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.append(glyph("close"));
    closeBtn.title = l10n.t("Close (Esc)");
    closeBtn.setAttribute("aria-label", l10n.t("Close"));
    head.append(h, closeBtn);
    panel = mavenConfigPanel("project", applyConfig, config);
    card.append(head, panel.node);
    const opened = panel;
    openModal((close) => {
      closeBtn.addEventListener("click", close);
      return {
        card,
        focusEl: closeBtn,
        label: l10n.t("Project Maven settings"),
        onClose: () => { if (panel === opened) panel = undefined; },
      };
    });
    updateButtons();
  };
  gearBtn.addEventListener("click", openProjectSettings);

  const applyTask = (next: MavenTaskState): void => {
    if (normalizePath(next.root) !== normalizedRoot) return;
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
      await panel?.settled();
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
      host.invoke("maven:settings", { scope: "project" }),
      host.invoke("maven:state", undefined),
      host.invoke("maven:logs", undefined),
    ]);
  } catch (error) {
    if (wrap.isConnected) toast(String(error), "error");
    return;
  }
  if (!wrap.isConnected) return;
  tree = modules;
  applyConfig(settings);
  paintModules();
  if (current) applyTask(current);
  for (const log of logs) queueLog(log);
  initializing = false;
  if (queued.length && !frame) frame = requestAnimationFrame(drain);
  updateStatus();
  updateButtons();
}
