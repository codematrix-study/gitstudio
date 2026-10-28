// App-wide user settings, persisted as userData/app-settings.json (the same
// tolerant-JSON pattern as errorReporter's store). Electron-free by design —
// every path is injected — so the store unit-tests under plain node.
//
// It holds clone preferences (the "Repositories" Settings card) and Maven
// defaults/overrides for the desktop Deploy view:
//   • cloneDir           — where one-click opens and clones land by default
//   • askWhereEveryTime  — force the destination sheet on every clone/open

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppSettingsView, GradleDetected, GradlePaths, GradleScope, GradleSettingsView, MavenDetected, MavenPaths, MavenScope, MavenSettingsView } from "../shared/ipc";

export const EMPTY_MAVEN: MavenPaths = { mavenHome: "", settings: "", localRepository: "", javaHome: "" };
const MAVEN_KEYS = Object.keys(EMPTY_MAVEN) as Array<keyof MavenPaths>;

type MavenProject = MavenPaths & { useWrapper?: boolean };
export const EMPTY_GRADLE: GradlePaths = { gradleHome: "", userHome: "", javaHome: "" };
const GRADLE_KEYS = Object.keys(EMPTY_GRADLE) as Array<keyof GradlePaths>;
type GradleProject = GradlePaths & { useWrapper?: boolean };

export function resolveGradlePaths(project: GradlePaths, global: GradlePaths, fallback: GradlePaths): GradlePaths {
  const out = { ...EMPTY_GRADLE };
  for (const key of GRADLE_KEYS) out[key] = project[key].trim() || global[key].trim() || fallback[key];
  return out;
}

function gradlePaths(value: unknown): GradlePaths {
  const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out = { ...EMPTY_GRADLE };
  for (const key of GRADLE_KEYS) out[key] = typeof r[key] === "string" ? r[key] as string : "";
  return out;
}

function gradleProject(value: unknown): GradleProject {
  const useWrapper = value && typeof value === "object" ? (value as Record<string, unknown>).useWrapper : undefined;
  return typeof useWrapper === "boolean" ? { ...gradlePaths(value), useWrapper } : gradlePaths(value);
}

/** Field by field: the project's value, else the global one, else `fallback`
 *  (what was detected on this machine). */
export function resolveMavenPaths(project: MavenPaths, global: MavenPaths, fallback: MavenPaths): MavenPaths {
  const out = { ...EMPTY_MAVEN };
  for (const key of MAVEN_KEYS) out[key] = project[key].trim() || global[key].trim() || fallback[key];
  return out;
}

function mavenPaths(value: unknown): MavenPaths {
  const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out = { ...EMPTY_MAVEN };
  for (const key of MAVEN_KEYS) out[key] = typeof r[key] === "string" ? r[key] as string : "";
  return out;
}

function mavenProject(value: unknown): MavenProject {
  const useWrapper = value && typeof value === "object" ? (value as Record<string, unknown>).useWrapper : undefined;
  return typeof useWrapper === "boolean" ? { ...mavenPaths(value), useWrapper } : mavenPaths(value);
}

interface Persisted {
  cloneDir?: string;
  askWhereEveryTime?: boolean;
  /** Folders GitStudio scans for repositories, besides the clone folder. */
  repoFolders?: string[];
  /** "Open in editor" choices: detected editors hidden from the menu, the
   *  default, and any editor the user added by command. Opt-OUT for hidden,
   *  so an editor installed tomorrow shows up on its own. */
  editors?: {
    hidden?: string[];
    defaultId?: string;
    custom?: Array<{ id: string; name: string; command: string }>;
  };
  /** The Commit Graph's branch filter (issue #30), per repository root:
   *  fully-qualified ref names. A repo with no entry shows every branch. */
  graphRefFilters?: Record<string, string[]>;
  mavenGlobal?: MavenPaths;
  mavenProjects?: Record<string, MavenProject>;
  gradleGlobal?: GradlePaths;
  gradleProjects?: Record<string, GradleProject>;
}

export class AppSettings {
  private constructor(
    private readonly file: string,
    private readonly data: Persisted,
    private readonly defaultCloneDir: string,
    private readonly home: string,
  ) {}

  /**
   * Load (or initialize) the settings store. `userDataDir` is where the JSON
   * lives; `defaultCloneDir`/`home` come from Electron in production and from
   * temp dirs in tests.
   */
  static async load(
    userDataDir: string,
    o: { defaultCloneDir: string; home: string },
  ): Promise<AppSettings> {
    const file = join(userDataDir, "app-settings.json");
    let data: Persisted = {};
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (typeof r.cloneDir === "string" && r.cloneDir.trim()) data.cloneDir = r.cloneDir;
        if (typeof r.askWhereEveryTime === "boolean") data.askWhereEveryTime = r.askWhereEveryTime;
        if (Array.isArray(r.repoFolders)) {
          data.repoFolders = r.repoFolders.filter(
            (f): f is string => typeof f === "string" && !!f.trim(),
          );
        }
        const ed = r.editors as Record<string, unknown> | undefined;
        if (ed && typeof ed === "object") {
          data.editors = {
            hidden: Array.isArray(ed.hidden) ? ed.hidden.filter((x): x is string => typeof x === "string") : [],
            defaultId: typeof ed.defaultId === "string" ? ed.defaultId : undefined,
            custom: Array.isArray(ed.custom)
              ? ed.custom
                  .filter(
                    (c): c is { id: string; name: string; command: string } =>
                      !!c && typeof c === "object" &&
                      typeof (c as { id?: unknown }).id === "string" &&
                      typeof (c as { name?: unknown }).name === "string" &&
                      typeof (c as { command?: unknown }).command === "string",
                  )
                  .map((c) => ({ id: c.id, name: c.name, command: c.command }))
              : [],
          };
        }
        const gf = r.graphRefFilters as Record<string, unknown> | undefined;
        if (gf && typeof gf === "object" && !Array.isArray(gf)) {
          data.graphRefFilters = {};
          for (const [root, refs] of Object.entries(gf)) {
            if (!Array.isArray(refs)) continue;
            const names = refs.filter((x): x is string => typeof x === "string" && !!x);
            if (names.length) data.graphRefFilters[root] = names;
          }
        }
        if (r.mavenGlobal && typeof r.mavenGlobal === "object" && !Array.isArray(r.mavenGlobal)) {
          data.mavenGlobal = mavenPaths(r.mavenGlobal);
        }
        const projects = r.mavenProjects;
        if (projects && typeof projects === "object" && !Array.isArray(projects)) {
          data.mavenProjects = Object.fromEntries(
            Object.entries(projects).map(([root, value]) => [root, mavenProject(value)]),
          );
        }
        if (r.gradleGlobal && typeof r.gradleGlobal === "object" && !Array.isArray(r.gradleGlobal)) {
          data.gradleGlobal = gradlePaths(r.gradleGlobal);
        }
        const gradleProjects = r.gradleProjects;
        if (gradleProjects && typeof gradleProjects === "object" && !Array.isArray(gradleProjects)) {
          data.gradleProjects = Object.fromEntries(
            Object.entries(gradleProjects).map(([root, value]) => [root, gradleProject(value)]),
          );
        }
      }
    } catch {
      data = {}; // missing / unreadable / malformed — start fresh
    }
    return new AppSettings(file, data, o.defaultCloneDir, o.home);
  }

  /** The effective default clone parent — the preference, or the built-in. */
  effectiveCloneDir(): string {
    return this.data.cloneDir ?? this.defaultCloneDir;
  }

  askWhereEveryTime(): boolean {
    return this.data.askWhereEveryTime ?? false;
  }

  /** Folders scanned for repositories, besides the clone folder. */
  repoFolders(): string[] {
    return this.data.repoFolders ?? [];
  }

  /**
   * Track a folder, if it is not already covered.
   *
   * Returns whether anything changed, so callers on a hot path — every repo
   * open goes through here — can skip a write and a re-render when it did not.
   * The clone folder is never added: it is always scanned, and listing it here
   * as well would let "remove" imply it could be untracked.
   */
  async addRepoFolder(dir: string): Promise<boolean> {
    const next = dir.trim();
    if (!next) return false;
    if (resolve(next) === resolve(this.effectiveCloneDir())) return false;
    const have = this.repoFolders();
    if (have.some((f) => resolve(f) === resolve(next))) return false;
    this.data.repoFolders = [...have, next];
    await this.persist();
    return true;
  }

  async removeRepoFolder(dir: string): Promise<boolean> {
    const have = this.repoFolders();
    const kept = have.filter((f) => resolve(f) !== resolve(dir));
    if (kept.length === have.length) return false;
    this.data.repoFolders = kept;
    await this.persist();
    return true;
  }

  /** The "Open in editor" preferences, always in full shape. */
  editorPrefs(): { hidden: string[]; defaultId?: string; custom: Array<{ id: string; name: string; command: string }> } {
    const e = this.data.editors ?? {};
    return { hidden: e.hidden ?? [], defaultId: e.defaultId, custom: e.custom ?? [] };
  }

  async setEditorShown(id: string, shown: boolean): Promise<void> {
    const prefs = this.editorPrefs();
    const hidden = new Set(prefs.hidden);
    if (shown) hidden.delete(id);
    else hidden.add(id);
    this.data.editors = { ...prefs, hidden: [...hidden] };
    await this.persist();
  }

  async setDefaultEditor(id: string | null): Promise<void> {
    const prefs = this.editorPrefs();
    this.data.editors = { ...prefs, defaultId: id ?? undefined };
    await this.persist();
  }

  async addCustomEditor(name: string, command: string): Promise<string> {
    const prefs = this.editorPrefs();
    const id = `custom-${Date.now().toString(36)}`;
    this.data.editors = { ...prefs, custom: [...prefs.custom, { id, name: name.trim(), command: command.trim() }] };
    await this.persist();
    return id;
  }

  async removeCustomEditor(id: string): Promise<void> {
    const prefs = this.editorPrefs();
    this.data.editors = {
      ...prefs,
      custom: prefs.custom.filter((c) => c.id !== id),
      hidden: prefs.hidden.filter((h) => h !== id),
      defaultId: prefs.defaultId === id ? undefined : prefs.defaultId,
    };
    await this.persist();
  }

  /** The Commit Graph's branch filter for a repository, or null for all. */
  graphRefFilter(root: string): string[] | null {
    const refs = this.data.graphRefFilters?.[root];
    return refs && refs.length > 0 ? [...refs] : null;
  }

  /** Remember (or, with null / an empty list, forget) a repository's filter. */
  async setGraphRefFilter(root: string, refs: string[] | null): Promise<void> {
    const all = { ...(this.data.graphRefFilters ?? {}) };
    if (refs && refs.length > 0) all[root] = [...refs];
    else delete all[root];
    if (Object.keys(all).length > 0) this.data.graphRefFilters = all;
    else delete this.data.graphRefFilters;
    await this.persist();
  }

  /**
   * The Maven settings as one scope sees them. Without a `root` (Settings, or
   * no repository open) there is no project layer and no wrapper.
   */
  mavenSettings(root: string | undefined, detected: MavenDetected, wrapperAvailable = false): MavenSettingsView {
    const global = mavenPaths(this.data.mavenGlobal);
    const stored = root ? this.data.mavenProjects?.[resolve(root)] : undefined;
    const project = root ? mavenPaths(stored) : undefined;
    const useWrapper = stored?.useWrapper;
    return {
      global,
      project,
      detected,
      effective: resolveMavenPaths(project ?? EMPTY_MAVEN, global, detected.paths),
      wrapperAvailable,
      useWrapper,
      wrapper: wrapperAvailable && useWrapper !== false,
    };
  }

  async setMavenSettings(
    root: string | undefined,
    scope: MavenScope,
    patch: Partial<MavenPaths> & { useWrapper?: boolean | null },
  ): Promise<void> {
    const clean: Partial<MavenPaths> = {};
    for (const key of MAVEN_KEYS) if (typeof patch[key] === "string") clean[key] = patch[key]!.trim();
    if (scope === "global") this.data.mavenGlobal = { ...mavenPaths(this.data.mavenGlobal), ...clean };
    else if (root) {
      const key = resolve(root);
      const next: MavenProject = { ...mavenProject(this.data.mavenProjects?.[key]), ...clean };
      if (patch.useWrapper === null) delete next.useWrapper;
      else if (typeof patch.useWrapper === "boolean") next.useWrapper = patch.useWrapper;
      this.data.mavenProjects = { ...this.data.mavenProjects, [key]: next };
    } else return;
    await this.persist();
  }

  gradleSettings(root: string | undefined, detected: GradleDetected, wrapperAvailable = false): GradleSettingsView {
    const global = gradlePaths(this.data.gradleGlobal);
    const stored = root ? this.data.gradleProjects?.[resolve(root)] : undefined;
    const project = root ? gradlePaths(stored) : undefined;
    const useWrapper = stored?.useWrapper;
    return {
      global,
      project,
      detected,
      effective: resolveGradlePaths(project ?? EMPTY_GRADLE, global, detected.paths),
      wrapperAvailable,
      useWrapper,
      wrapper: wrapperAvailable && useWrapper !== false,
    };
  }

  async setGradleSettings(
    root: string | undefined,
    scope: GradleScope,
    patch: Partial<GradlePaths> & { useWrapper?: boolean | null },
  ): Promise<void> {
    const clean: Partial<GradlePaths> = {};
    for (const key of GRADLE_KEYS) if (typeof patch[key] === "string") clean[key] = patch[key]!.trim();
    if (scope === "global") this.data.gradleGlobal = { ...gradlePaths(this.data.gradleGlobal), ...clean };
    else if (root) {
      const key = resolve(root);
      const next: GradleProject = { ...gradleProject(this.data.gradleProjects?.[key]), ...clean };
      if (patch.useWrapper === null) delete next.useWrapper;
      else if (typeof patch.useWrapper === "boolean") next.useWrapper = patch.useWrapper;
      this.data.gradleProjects = { ...this.data.gradleProjects, [key]: next };
    } else return;
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      /* best-effort — settings still apply for this session */
    }
  }

  view(): AppSettingsView {
    const dir = this.effectiveCloneDir();
    return {
      cloneDir: dir,
      cloneDirDisplay: dir.startsWith(this.home) ? `~${dir.slice(this.home.length)}` : dir,
      cloneDirIsDefault: this.data.cloneDir === undefined,
      askWhereEveryTime: this.askWhereEveryTime(),
      repoFolders: this.repoFolders(),
    };
  }

  /** Apply a patch (null cloneDir resets to the default) and persist. */
  async update(patch: { cloneDir?: string | null; askWhereEveryTime?: boolean }): Promise<AppSettingsView> {
    if (patch.cloneDir === null) delete this.data.cloneDir;
    else if (typeof patch.cloneDir === "string" && patch.cloneDir.trim()) {
      this.data.cloneDir = patch.cloneDir;
    }
    if (typeof patch.askWhereEveryTime === "boolean") {
      this.data.askWhereEveryTime = patch.askWhereEveryTime;
    }
    await this.persist();
    return this.view();
  }
}
