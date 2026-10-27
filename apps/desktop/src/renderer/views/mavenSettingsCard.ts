// Settings ▸ Maven — the global Maven paths every repository's Deploy view
// inherits. Empty fields fall back to what main detected on this computer
// (MAVEN_HOME, `mvn` on PATH, ~/.m2/settings.xml, …); a repository can still
// override any of them from the gear on its Deploy page.

import * as l10n from "@vscode/l10n";
import { settingsCard } from "../ui";
import { mavenConfigPanel } from "./mavenConfigFields";

export function mavenSettingsCard(): HTMLElement {
  const { card, body } = settingsCard(l10n.t("Maven"), "package");
  card.classList.add("maven-settings-card");
  body.append(mavenConfigPanel("global").node);
  return card;
}
