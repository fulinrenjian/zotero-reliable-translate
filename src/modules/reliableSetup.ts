import { config } from "../../package.json";
import { getString } from "../utils/locale";

const LEGACY_ADDON_ID = "zoteropdftranslate@euclpts.com";
const LEGACY_PREFS_PREFIX = "extensions.zotero.ZoteroPDFTranslate.";
const MIGRATION_MARKER = "reliableSetup.migratedFrom248";

export interface ReliableSetupResult {
  shouldActivate: boolean;
  /** Whether this invocation completed a migration that copied user prefs. */
  migrated: boolean;
}

type AddonManagerAPI = {
  AUTOUPDATE_DISABLE?: number;
  getAddonByID(id: string): Promise<{
    isActive: boolean;
    applyBackgroundUpdates?: number;
  } | null>;
};

/**
 * Called after initLocale(), before default settings or event registration.
 * Credentials, when configured, are copied only between local preference
 * branches. No preference names or values are logged, exported, or transmitted.
 */
export async function prepareReliableSetup(): Promise<ReliableSetupResult> {
  let migrated = false;
  try {
    migrated = migrateLegacyUserPreferences();
  } catch {
    notifySetupPaused("reliable-setup-migration-failed");
    return { shouldActivate: false, migrated: false };
  }

  try {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    ) as { AddonManager: AddonManagerAPI };
    // Local distributions must still declare an HTTPS URL to satisfy Zotero's
    // installer. This fork has no update server and is updated manually.
    const customAddon = await AddonManager.getAddonByID(config.addonID);
    if (customAddon && typeof AddonManager.AUTOUPDATE_DISABLE === "number") {
      customAddon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    const legacyAddon = await AddonManager.getAddonByID(LEGACY_ADDON_ID);
    if (legacyAddon?.isActive) {
      notifySetupPaused("reliable-setup-original-active");
      return { shouldActivate: false, migrated };
    }
  } catch {
    // Fail closed rather than risking two plugins sending the same selection.
    // A generic notification intentionally omits the underlying error object.
    notifySetupPaused("reliable-setup-status-unknown");
    return { shouldActivate: false, migrated };
  }

  return { shouldActivate: true, migrated };
}

function migrateLegacyUserPreferences(): boolean {
  const prefService = Services.prefs;
  const source = prefService.getBranch(LEGACY_PREFS_PREFIX);
  const destination = prefService.getBranch(`${config.prefsPrefix}.`);
  if (
    destination.prefHasUserValue(MIGRATION_MARKER) &&
    destination.getBoolPref(MIGRATION_MARKER)
  ) {
    return false;
  }

  let copied = false;
  for (const name of source.getChildList("")) {
    if (
      !source.prefHasUserValue(name) ||
      destination.prefHasUserValue(name) ||
      name === MIGRATION_MARKER
    ) {
      continue;
    }
    // Never overwrite an explicit setting in the custom plugin. Unsupported
    // pref types are ignored; the original branch is never written to.
    switch (source.getPrefType(name)) {
      case prefService.PREF_BOOL:
        destination.setBoolPref(name, source.getBoolPref(name));
        copied = true;
        break;
      case prefService.PREF_INT:
        destination.setIntPref(name, source.getIntPref(name));
        copied = true;
        break;
      case prefService.PREF_STRING:
        destination.setStringPref(name, source.getStringPref(name));
        copied = true;
        break;
    }
  }
  // Persist the marker only after every supported preference has been copied.
  // If a write fails, the next startup can safely retry the remaining values.
  destination.setBoolPref(MIGRATION_MARKER, true);
  // nsIPrefService accepts null to write the default profile preference file;
  // the generated platform typings currently mark this parameter non-nullable.
  prefService.savePrefFile(
    null as unknown as Parameters<typeof prefService.savePrefFile>[0],
  );
  return copied;
}

function notifySetupPaused(messageID: string): void {
  const text = getString(messageID);
  try {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 12000 })
      .createLine({ text, type: "fail" })
      .show();
  } catch {
    // The fallback remains local and contains no configuration values.
    try {
      Services.prompt.alert(
        Zotero.getMainWindow() as unknown as Parameters<
          typeof Services.prompt.alert
        >[0],
        config.addonName,
        text,
      );
    } catch {
      Zotero.debug(
        "Reliable Translate startup paused; see custom setup guide.",
      );
    }
  }
}
