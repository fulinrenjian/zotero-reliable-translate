import { config } from "../../package.json";

const SPEED_MARKER = "reliableSpeed.upgraded011";

/** Apply this tested default once; later explicit source choices stay intact. */
export function applyReliableSpeedUpgrade(): void {
  const branch = Services.prefs.getBranch(`${config.prefsPrefix}.`);
  if (branch.getBoolPref(SPEED_MARKER, false)) return;
  const current = branch.getStringPref("translateSource", "");
  if (!current || current === "cnki") {
    branch.setStringPref("reliableSpeed.previousSource", current);
    branch.setStringPref("translateSource", "bing");
  }
  branch.setBoolPref(SPEED_MARKER, true);
  Services.prefs.savePrefFile(
    null as unknown as Parameters<typeof Services.prefs.savePrefFile>[0],
  );
}
