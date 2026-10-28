import * as l10n from "@vscode/l10n";
import { host, currentSession } from "../bridge";
import { openModal, toast } from "../dialogs";
import { copyText, el, emptyState, glyph, settingsCard } from "../ui";
import type { GradleLogChunk, GradleModule, GradleSettingsView, GradleTaskState } from "../../shared/ipc";
import { normalizePath } from "../../shared/repoGrouping";
import type { SectionRender } from "./common";
import { gradleConfigPanel, gradleSummary, type GradleConfigPanel } from "./gradleConfigFields";

function button(label: string, className = "mini-btn"): HTMLButtonElement {
  const node = el("button", className) as HTMLButtonElement;
  node.type = "button";
  node.textContent = label;
  return node;
}

export const renderGradleDeploy: SectionRender = (wrap) => { void mount(wrap); };

async function mount(wrap: HTMLElement): Promise<void> {
  const root = currentSession()?.root;
  if (!root) return;
  const normalizedRoot = normalizePath(root);
  const view = el("div", "maven-page");
  const header = el("div", "maven-header");
  const heading = el("div", "maven-heading");
  const title = el("h1", "maven-title");
  title.textContent = l10n.t("Gradle deployment");
  const summary = el("div", "maven-summary");
  heading.append(title, summary);
  const gearBtn = el("button", "icon-btn maven-gear") as HTMLButtonElement;
  gearBtn.type = "button";
  gearBtn.append(glyph("gear"));
  gearBtn.title = l10n.t("Project Gradle settings");
  gearBtn.setAttribute("aria-label", l10n.t("Project Gradle settings"));
  header.append(heading, gearBtn);
  view.append(header);

  const moduleCard = settingsCard(l10n.t("Gradle modules"), "package");
  const tools = el("div", "maven-tools");
  const filter = document.createElement("input");
  filter.className = "settings-input maven-filter";
  filter.type = "search";
  filter.placeholder = l10n.t("Filter…");
  const allBtn = button(l10n.t("Select all"));
  const noneBtn = button(l10n.t("Select none"));
  const refreshBtn = button(l10n.t("Refresh"));
  tools.append(filter, allBtn, noneBtn, refreshBtn);
  const moduleList = el("div", "maven-modules");
  moduleCard.body.append(tools, moduleList);

  const operationCard = settingsCard(l10n.t("Gradle actions"), "play");
  const actionRow = el("div", "maven-actions");
  const goals = [
    { goal: "clean", label: l10n.t("Clean") },
    { goal: "assembleDebug", label: l10n.t("Debug APK") },
    { goal: "assembleRelease", label: l10n.t("Release APK") },
    { goal: "bundleDebug", label: l10n.t("Debug AAB") },
    { goal: "bundleRelease", label: l10n.t("Release AAB") },
  ];
  const actions = goals.map(({ goal, label }) => {
    const action = button(label, goal === "bundleRelease" ? "btn-primary" : "btn");
    actionRow.append(action);
    return { goal, button: action };
  });
  const customRow = el("div", "gradle-custom-row");
  const customSelect = document.createElement("select");
  customSelect.className = "settings-input";
  customSelect.setAttribute("aria-label", l10n.t("Custom Gradle task"));
  const customBtn = button(l10n.t("Run task"), "btn");
  customRow.append(customSelect, customBtn);
  const stopBtn = button(l10n.t("Stop"), "btn-danger");
  stopBtn.hidden = true;
  actionRow.append(stopBtn);
  const hint = el("div", "settings-sub");
  hint.textContent = l10n.t("Select a module to run Gradle.");
  operationCard.body.append(actionRow, customRow, hint);
  const main = el("div", "maven-main");
  main.append(moduleCard.card, operationCard.card);
  view.append(main);

  const logCard = settingsCard(l10n.t("Gradle log"), "output");
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

  let tree: GradleModule | undefined;
  let config: GradleSettingsView | undefined;
  let task: GradleTaskState | undefined;
  let panel: GradleConfigPanel | undefined;
  let taskId = "";
  let seenSeq = 0;
  let initializing = true;
  let follow = true;
  const selected = new Set<string>();
  const available = new Map<string, GradleModule>();
  const visible = new Set<string>();
  const queued: GradleLogChunk[] = [];
  const carry: Record<GradleLogChunk["stream"], string> = { stdout: "", stderr: "", system: "" };
  let frame = 0;

  const updateButtons = (): void => {
    const running = task?.status === "running";
    for (const action of actions) action.button.disabled = running || selected.size === 0;
    customSelect.disabled = running || selected.size === 0;
    customBtn.disabled = running || selected.size === 0 || !customSelect.value;
    stopBtn.hidden = !running;
    stopBtn.disabled = !running;
    allBtn.disabled = noneBtn.disabled = refreshBtn.disabled = running;
    moduleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((box) => { box.disabled = running; });
    gearBtn.disabled = running;
    panel?.setDisabled(running);
    hint.hidden = selected.size > 0;
  };
  const updateStatus = (): void => {
    if (!task) { status.textContent = l10n.t("No Gradle task yet"); return; }
    const label = task.status === "running" ? l10n.t("Running")
      : task.status === "success" ? l10n.t("Succeeded")
      : task.status === "stopped" ? l10n.t("Stopped")
      : l10n.t("Failed (exit code {0})", task.exitCode ?? "?");
    const duration = Math.floor(((task.endedAt || Date.now()) - task.startedAt) / 1000);
    status.textContent = `${label} · ${new Date(task.startedAt).toLocaleTimeString()} · ${duration}s`;
  };
  const clearLog = (): void => {
    logLines.replaceChildren();
    carry.stdout = carry.stderr = carry.system = "";
    queued.length = 0;
    follow = true;
  };
  const drain = (): void => {
    frame = 0;
    const rows: Array<{ stream: GradleLogChunk["stream"]; line: string }> = [];
    for (const chunk of queued.splice(0).sort((a, b) => a.seq - b.seq)) {
      if (chunk.seq <= seenSeq || (taskId && chunk.id !== taskId)) continue;
      seenSeq = chunk.seq;
      const parts = (carry[chunk.stream] + chunk.text).split(/\r?\n/);
      carry[chunk.stream] = parts.pop() || "";
      for (const line of parts) rows.push({ stream: chunk.stream, line });
    }
    if (task?.status !== "running") {
      for (const stream of ["stdout", "stderr", "system"] as const) {
        if (carry[stream]) rows.push({ stream, line: carry[stream] });
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
  const queueLog = (chunk: GradleLogChunk): void => {
    if (normalizePath(chunk.root) !== normalizedRoot || chunk.seq <= seenSeq) return;
    queued.push(chunk);
    if (!initializing && !frame) frame = requestAnimationFrame(drain);
  };
  logScroll.addEventListener("scroll", () => {
    follow = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 48;
  });
  clearBtn.addEventListener("click", clearLog);
  copyBtn.addEventListener("click", () => void copyText(Array.from(logLines.children, (row) => row.textContent || "").join("\n")));

  const paintCustom = (): void => {
    const previous = customSelect.value;
    const selectedNodes = [...selected].map((path) => available.get(path)).filter((node): node is GradleModule => !!node);
    let names: string[] = [];
    if (selected.has(":")) {
      names = [...new Set([...available.values()].flatMap((node) => node.tasks))];
    } else if (selectedNodes.length) {
      names = selectedNodes[0].tasks.filter((name) => selectedNodes.every((node) => node.tasks.includes(name)));
    }
    const fixed = new Set(goals.map(({ goal }) => goal));
    customSelect.replaceChildren();
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = l10n.t("Select a custom task…");
    customSelect.append(prompt);
    for (const name of names.filter((item) => !fixed.has(item)).sort()) {
      const option = document.createElement("option");
      option.value = option.textContent = name;
      customSelect.append(option);
    }
    customSelect.value = names.includes(previous) ? previous : "";
    updateButtons();
  };
  const paintModules = (): void => {
    available.clear();
    visible.clear();
    moduleList.replaceChildren();
    if (!tree) {
      moduleList.append(emptyState(l10n.t("No Gradle modules"), l10n.t("Gradle project information is unavailable.")));
      paintCustom();
      return;
    }
    const query = filter.value.trim().toLowerCase();
    const build = (node: GradleModule): HTMLElement | undefined => {
      available.set(node.path, node);
      const children = node.children.map(build).filter((item): item is HTMLElement => !!item);
      const matches = !query || node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
      if (!matches && !children.length) return undefined;
      if (matches) visible.add(node.path);
      const item = el("li", "maven-module");
      const label = el("label", "maven-module-label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.disabled = !matches;
      check.hidden = !matches;
      check.checked = selected.has(node.path);
      check.addEventListener("change", () => {
        if (check.checked) selected.add(node.path);
        else selected.delete(node.path);
        paintCustom();
      });
      const name = el("span");
      name.textContent = node.name;
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
    else moduleList.append(emptyState(l10n.t("No results"), l10n.t("Nothing matches “{0}”.", filter.value.trim())));
    for (const path of selected) if (!available.has(path)) selected.delete(path);
    paintCustom();
  };
  const refreshModules = async (): Promise<void> => {
    refreshBtn.disabled = true;
    moduleList.replaceChildren(emptyState(l10n.t("Detecting Gradle modules…"), l10n.t("Gradle is evaluating this project.")));
    try { tree = await host.invoke("gradle:modules", undefined); if (wrap.isConnected) paintModules(); }
    catch (error) {
      if (wrap.isConnected) {
        tree = undefined;
        selected.clear();
        available.clear();
        moduleList.replaceChildren(emptyState(l10n.t("Gradle detection failed"), String(error)));
        paintCustom();
        updateButtons();
      }
    } finally { refreshBtn.disabled = false; updateButtons(); }
  };
  allBtn.addEventListener("click", () => { for (const path of visible) selected.add(path); paintModules(); });
  noneBtn.addEventListener("click", () => { selected.clear(); paintModules(); });
  refreshBtn.addEventListener("click", () => void refreshModules());
  filter.addEventListener("input", paintModules);
  customSelect.addEventListener("change", updateButtons);

  const applyConfig = (next: GradleSettingsView): void => {
    config = next;
    summary.textContent = gradleSummary(next);
    summary.title = summary.textContent;
  };
  gearBtn.addEventListener("click", () => {
    if (task?.status === "running") return;
    const card = el("div", "modal-card modal-card-form maven-settings-dialog");
    const head = el("div", "maven-dialog-head");
    const h = el("div", "modal-title");
    h.textContent = l10n.t("Project Gradle settings");
    const closeBtn = el("button", "icon-btn") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.append(glyph("close"));
    closeBtn.title = l10n.t("Close (Esc)");
    head.append(h, closeBtn);
    panel = gradleConfigPanel("project", applyConfig, config);
    card.append(head, panel.node);
    const opened = panel;
    openModal((close) => {
      closeBtn.addEventListener("click", close);
      return { card, focusEl: closeBtn, label: l10n.t("Project Gradle settings"), onClose: () => { if (panel === opened) panel = undefined; } };
    });
    updateButtons();
  });

  const applyTask = (next: GradleTaskState): void => {
    if (normalizePath(next.root) !== normalizedRoot) return;
    if (task && next.startedAt < task.startedAt) return;
    if (taskId && taskId !== next.id) { clearLog(); seenSeq = 0; }
    taskId = next.id;
    task = next;
    updateStatus();
    updateButtons();
    if (next.status !== "running" && !frame) frame = requestAnimationFrame(drain);
  };
  const start = async (goal: string): Promise<void> => {
    if (!selected.size || task?.status === "running") return;
    await panel?.settled();
    try {
      const result = await host.invoke("gradle:start", { goal, paths: [...selected] });
      if (!result.ok) toast(result.message || l10n.t("Gradle could not start"), "error");
      else if (result.state) applyTask(result.state);
    } catch (error) { toast(String(error), "error"); }
  };
  for (const { goal, button: action } of actions) action.addEventListener("click", () => void start(goal));
  customBtn.addEventListener("click", () => { if (customSelect.value) void start(customSelect.value); });
  stopBtn.addEventListener("click", () => void host.invoke("gradle:stop", undefined));

  const offLog = host.on("gradle:log", queueLog);
  const offState = host.on("gradle:state", applyTask);
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

  let settings: GradleSettingsView;
  let current: GradleTaskState | undefined;
  let logs: GradleLogChunk[];
  try {
    [settings, current, logs] = await Promise.all([
      host.invoke("gradle:settings", { scope: "project" }),
      host.invoke("gradle:state", undefined),
      host.invoke("gradle:logs", undefined),
    ]);
  } catch (error) {
    if (wrap.isConnected) toast(String(error), "error");
    return;
  }
  if (!wrap.isConnected) return;
  applyConfig(settings);
  if (current) applyTask(current);
  for (const log of logs) queueLog(log);
  initializing = false;
  if (queued.length && !frame) frame = requestAnimationFrame(drain);
  updateStatus();
  updateButtons();
  void refreshModules();
}
