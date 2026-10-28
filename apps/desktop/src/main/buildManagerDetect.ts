import { stat } from "node:fs/promises";
import { join } from "node:path";

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function detectBuildManagers(root: string): Promise<{ maven: boolean; gradle: boolean }> {
  const [maven, settingsGroovy, settingsKotlin, buildGroovy, buildKotlin] = await Promise.all([
    "pom.xml", "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
  ].map((name) => fileExists(join(root, name))));
  return { maven, gradle: settingsGroovy || settingsKotlin || buildGroovy || buildKotlin };
}
