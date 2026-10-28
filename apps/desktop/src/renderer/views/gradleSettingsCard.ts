import * as l10n from "@vscode/l10n";
import { settingsCard } from "../ui";
import { gradleConfigPanel } from "./gradleConfigFields";

export function gradleSettingsCard(): HTMLElement {
  const { card, body } = settingsCard(l10n.t("Gradle"), "package");
  body.append(gradleConfigPanel("global").node);
  return card;
}
