#!/usr/bin/env node
// ONE-OFF (delete after running): fold the Maven settings rework's messages into
// l10n/<locale>.json and drop the ones no product asks for any more.
// Run AFTER `node scripts/i18n/bundle-nls.mjs --write`, then run --write again
// so every shipped product's cut matches the catalog.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const BUNDLES = ["apps/extension/l10n", "apps/merge-studio/l10n", "apps/desktop/l10n"];
const KEYS = [
  "Maven",
  "Maven home",
  "User settings file",
  "Local repository",
  "JDK (JAVA_HOME)",
  "Re-detect",
  "Using the Maven wrapper (mvnw)",
  "Use global: {0}",
  "Not detected — Maven's default",
  "Auto-detected: {0}",
  "Use the Maven wrapper (mvnw)",
  "This repository ships mvnw; it runs the Maven version the project pins.",
  "Empty fields use the global Maven settings (Settings ▸ Maven).",
  "Empty fields use what was detected on this computer, the way IntelliJ IDEA does.",
  "Running mvn -v…",
  "Project Maven settings",
  "Choose the local repository",
  "The Maven wrapper (mvnw) is missing",
  "Reset",
];
// One row per locale, in KEYS order.
const T = {
  "zh-cn": ["Maven", "Maven 主目录", "用户设置文件", "本地仓库", "JDK (JAVA_HOME)", "重新检测", "正在使用 Maven wrapper (mvnw)", "使用全局：{0}", "未检测到 — 使用 Maven 默认值", "自动识别：{0}", "使用 Maven wrapper (mvnw)", "此仓库自带 mvnw，会使用项目固定的 Maven 版本。", "留空的字段使用全局 Maven 配置（设置 ▸ Maven）。", "留空的字段使用在本机自动识别到的配置，与 IntelliJ IDEA 相同。", "正在运行 mvn -v…", "项目 Maven 配置", "选择本地仓库", "缺少 Maven wrapper (mvnw)", "重置"],
  "zh-tw": ["Maven", "Maven 主目錄", "使用者設定檔", "本機儲存庫", "JDK (JAVA_HOME)", "重新偵測", "正在使用 Maven wrapper (mvnw)", "使用全域：{0}", "未偵測到 — 使用 Maven 預設值", "自動偵測：{0}", "使用 Maven wrapper (mvnw)", "此儲存庫附帶 mvnw，會使用專案固定的 Maven 版本。", "留空的欄位使用全域 Maven 設定（設定 ▸ Maven）。", "留空的欄位使用在這台電腦上偵測到的設定，與 IntelliJ IDEA 相同。", "正在執行 mvn -v…", "專案 Maven 設定", "選擇本機儲存庫", "缺少 Maven wrapper (mvnw)", "重設"],
  ja: ["Maven", "Maven ホーム", "ユーザー設定ファイル", "ローカルリポジトリ", "JDK (JAVA_HOME)", "再検出", "Maven ラッパー (mvnw) を使用中", "グローバル設定を使用: {0}", "検出されませんでした — Maven の既定値", "自動検出: {0}", "Maven ラッパー (mvnw) を使用", "このリポジトリには mvnw が含まれており、プロジェクトが指定する Maven バージョンで実行します。", "空欄の項目はグローバルの Maven 設定 (設定 ▸ Maven) を使用します。", "空欄の項目は、IntelliJ IDEA と同様にこのコンピューターで検出した値を使用します。", "mvn -v を実行中…", "プロジェクトの Maven 設定", "ローカルリポジトリを選択", "Maven ラッパー (mvnw) が見つかりません", "リセット"],
  ko: ["Maven", "Maven 홈", "사용자 설정 파일", "로컬 저장소", "JDK (JAVA_HOME)", "다시 감지", "Maven 래퍼(mvnw) 사용 중", "전역 설정 사용: {0}", "감지되지 않음 — Maven 기본값", "자동 감지: {0}", "Maven 래퍼(mvnw) 사용", "이 저장소에는 mvnw가 포함되어 있어 프로젝트가 지정한 Maven 버전으로 실행합니다.", "비워 둔 항목은 전역 Maven 설정(설정 ▸ Maven)을 사용합니다.", "비워 둔 항목은 IntelliJ IDEA처럼 이 컴퓨터에서 감지한 값을 사용합니다.", "mvn -v 실행 중…", "프로젝트 Maven 설정", "로컬 저장소 선택", "Maven 래퍼(mvnw)가 없습니다", "재설정"],
  de: ["Maven", "Maven-Verzeichnis", "Benutzereinstellungsdatei", "Lokales Repository", "JDK (JAVA_HOME)", "Erneut erkennen", "Maven Wrapper (mvnw) wird verwendet", "Global verwenden: {0}", "Nicht erkannt — Maven-Standard", "Automatisch erkannt: {0}", "Maven Wrapper (mvnw) verwenden", "Dieses Repository enthält mvnw; es verwendet die Maven-Version, die das Projekt festlegt.", "Leere Felder verwenden die globalen Maven-Einstellungen (Einstellungen ▸ Maven).", "Leere Felder verwenden, was auf diesem Computer erkannt wurde – wie in IntelliJ IDEA.", "mvn -v wird ausgeführt…", "Maven-Einstellungen des Projekts", "Lokales Repository auswählen", "Der Maven Wrapper (mvnw) fehlt", "Zurücksetzen"],
  fr: ["Maven", "Répertoire Maven", "Fichier de paramètres utilisateur", "Dépôt local", "JDK (JAVA_HOME)", "Détecter à nouveau", "Utilise le wrapper Maven (mvnw)", "Valeur globale : {0}", "Non détecté — valeur par défaut de Maven", "Détecté automatiquement : {0}", "Utiliser le wrapper Maven (mvnw)", "Ce dépôt fournit mvnw ; il exécute la version de Maven fixée par le projet.", "Les champs vides utilisent les paramètres Maven globaux (Paramètres ▸ Maven).", "Les champs vides utilisent ce qui a été détecté sur cet ordinateur, comme IntelliJ IDEA.", "Exécution de mvn -v…", "Paramètres Maven du projet", "Choisir le dépôt local", "Le wrapper Maven (mvnw) est introuvable", "Réinitialiser"],
  es: ["Maven", "Directorio de Maven", "Archivo de configuración de usuario", "Repositorio local", "JDK (JAVA_HOME)", "Volver a detectar", "Usando el wrapper de Maven (mvnw)", "Usar global: {0}", "No detectado — valor predeterminado de Maven", "Detectado automáticamente: {0}", "Usar el wrapper de Maven (mvnw)", "Este repositorio incluye mvnw; ejecuta la versión de Maven que fija el proyecto.", "Los campos vacíos usan la configuración global de Maven (Configuración ▸ Maven).", "Los campos vacíos usan lo detectado en este equipo, como IntelliJ IDEA.", "Ejecutando mvn -v…", "Configuración de Maven del proyecto", "Elegir el repositorio local", "Falta el wrapper de Maven (mvnw)", "Restablecer"],
  it: ["Maven", "Directory di Maven", "File di impostazioni utente", "Repository locale", "JDK (JAVA_HOME)", "Rileva di nuovo", "In uso il wrapper Maven (mvnw)", "Usa globale: {0}", "Non rilevato — predefinito di Maven", "Rilevato automaticamente: {0}", "Usa il wrapper Maven (mvnw)", "Questo repository include mvnw; esegue la versione di Maven fissata dal progetto.", "I campi vuoti usano le impostazioni Maven globali (Impostazioni ▸ Maven).", "I campi vuoti usano ciò che è stato rilevato su questo computer, come IntelliJ IDEA.", "Esecuzione di mvn -v…", "Impostazioni Maven del progetto", "Scegli il repository locale", "Manca il wrapper Maven (mvnw)", "Reimposta"],
  "pt-br": ["Maven", "Diretório do Maven", "Arquivo de configurações do usuário", "Repositório local", "JDK (JAVA_HOME)", "Detectar novamente", "Usando o wrapper do Maven (mvnw)", "Usar global: {0}", "Não detectado — padrão do Maven", "Detectado automaticamente: {0}", "Usar o wrapper do Maven (mvnw)", "Este repositório inclui o mvnw; ele executa a versão do Maven fixada pelo projeto.", "Campos vazios usam as configurações globais do Maven (Configurações ▸ Maven).", "Campos vazios usam o que foi detectado neste computador, como o IntelliJ IDEA.", "Executando mvn -v…", "Configurações do Maven do projeto", "Escolher o repositório local", "O wrapper do Maven (mvnw) está ausente", "Redefinir"],
  ru: ["Maven", "Каталог Maven", "Файл пользовательских настроек", "Локальный репозиторий", "JDK (JAVA_HOME)", "Определить заново", "Используется Maven Wrapper (mvnw)", "Глобальное значение: {0}", "Не найдено — по умолчанию Maven", "Найдено автоматически: {0}", "Использовать Maven Wrapper (mvnw)", "В этом репозитории есть mvnw; он запускает версию Maven, закреплённую в проекте.", "Пустые поля берут глобальные настройки Maven (Настройки ▸ Maven).", "Пустые поля берут значения, найденные на этом компьютере, как в IntelliJ IDEA.", "Выполняется mvn -v…", "Настройки Maven проекта", "Выберите локальный репозиторий", "Maven Wrapper (mvnw) не найден", "Сбросить"],
  pl: ["Maven", "Katalog Maven", "Plik ustawień użytkownika", "Repozytorium lokalne", "JDK (JAVA_HOME)", "Wykryj ponownie", "Używany jest wrapper Maven (mvnw)", "Użyj globalnego: {0}", "Nie wykryto — domyślne ustawienie Maven", "Wykryto automatycznie: {0}", "Użyj wrappera Maven (mvnw)", "To repozytorium zawiera mvnw; uruchamia ono wersję Maven ustaloną w projekcie.", "Puste pola używają globalnych ustawień Maven (Ustawienia ▸ Maven).", "Puste pola używają wartości wykrytych na tym komputerze, tak jak IntelliJ IDEA.", "Uruchamianie mvn -v…", "Ustawienia Maven projektu", "Wybierz repozytorium lokalne", "Brak wrappera Maven (mvnw)", "Resetuj"],
  cs: ["Maven", "Adresář Maven", "Soubor uživatelského nastavení", "Místní repozitář", "JDK (JAVA_HOME)", "Znovu zjistit", "Používá se Maven wrapper (mvnw)", "Použít globální: {0}", "Nezjištěno — výchozí hodnota Mavenu", "Zjištěno automaticky: {0}", "Použít Maven wrapper (mvnw)", "Tento repozitář obsahuje mvnw; spouští verzi Mavenu, kterou projekt určuje.", "Prázdná pole použijí globální nastavení Mavenu (Nastavení ▸ Maven).", "Prázdná pole použijí hodnoty zjištěné v tomto počítači, stejně jako IntelliJ IDEA.", "Spouští se mvn -v…", "Nastavení Mavenu pro projekt", "Vyberte místní repozitář", "Chybí Maven wrapper (mvnw)", "Obnovit výchozí"],
  tr: ["Maven", "Maven dizini", "Kullanıcı ayarları dosyası", "Yerel depo", "JDK (JAVA_HOME)", "Yeniden algıla", "Maven sarmalayıcısı (mvnw) kullanılıyor", "Geneli kullan: {0}", "Algılanmadı — Maven varsayılanı", "Otomatik algılandı: {0}", "Maven sarmalayıcısını (mvnw) kullan", "Bu depo mvnw içeriyor; projenin sabitlediği Maven sürümünü çalıştırır.", "Boş alanlar genel Maven ayarlarını kullanır (Ayarlar ▸ Maven).", "Boş alanlar, IntelliJ IDEA'da olduğu gibi bu bilgisayarda algılananı kullanır.", "mvn -v çalıştırılıyor…", "Proje Maven ayarları", "Yerel depoyu seç", "Maven sarmalayıcısı (mvnw) eksik", "Sıfırla"],
};

const wanted = new Set(BUNDLES.flatMap((dir) => Object.keys(JSON.parse(readFileSync(join(ROOT, dir, "bundle.l10n.json"), "utf8")))));
const catalog = join(ROOT, "l10n");
for (const name of readdirSync(catalog).filter((f) => f.endsWith(".json"))) {
  const locale = name.slice(0, -5);
  const rows = T[locale];
  if (!rows || rows.length !== KEYS.length) throw new Error(`no full row for ${locale}`);
  const file = join(catalog, name);
  const data = JSON.parse(readFileSync(file, "utf8"));
  KEYS.forEach((key, i) => { if (wanted.has(key) && !(key in data)) data[key] = rows[i]; });
  const dropped = Object.keys(data).filter((key) => !wanted.has(key));
  for (const key of dropped) delete data[key];
  const sorted = Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]]));
  writeFileSync(file, `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`${locale}: dropped ${JSON.stringify(dropped)}`);
}
