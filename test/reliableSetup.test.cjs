// All preferences and addon states below are synthetic, held in memory.
// The only file reads load project source/configuration, never Zotero profiles.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { Script } = require("node:vm");
const ts = require("typescript");

const root = resolve(__dirname, "..");
const config = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).config;
const code = ts.transpileModule(
  readFileSync(resolve(root, "src/modules/reliableSetup.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const marker = "reliableSetup.migratedFrom248";
const syntheticSecret = "synthetic-fixture-secret-never-a-real-credential";

function fixture(options = {}) {
  const original = new Map(
    options.original || [
      ["enableAuto", false],
      ["fontSize", 14],
      ["secretObj", JSON.stringify({ fixture: syntheticSecret })],
    ],
  );
  const custom = new Map(options.custom || []);
  const originalDefaults = new Map([["defaultOnly", "must-not-be-migrated"]]);
  const customDefaults = new Map([["enableAuto", true]]);
  const notices = [],
    logs = [],
    saves = [],
    checkedIDs = [];
  const backgroundUpdateWrites = [];
  const autoUpdateDisable = 0;
  function addonState(id, isActive) {
    let applyBackgroundUpdates = 1;
    return {
      isActive,
      get applyBackgroundUpdates() {
        return applyBackgroundUpdates;
      },
      set applyBackgroundUpdates(value) {
        backgroundUpdateWrites.push({ id, value });
        applyBackgroundUpdates = value;
      },
    };
  }
  const originalAddon = addonState(
    "zoteropdftranslate@euclpts.com",
    !!options.originalActive,
  );
  const customAddon = addonState(config.addonID, true);
  let failureName = options.failureName || "";

  const branch = (users, defaults, isOriginal) => {
    const read = (name) =>
      users.has(name) ? users.get(name) : defaults.get(name);
    const write = (name, value) => {
      assert.equal(
        isOriginal,
        false,
        "migration must not write the original branch",
      );
      if (name === failureName) {
        failureName = "";
        throw new Error(`synthetic write failure ${syntheticSecret}`);
      }
      users.set(name, value);
    };
    return {
      prefHasUserValue: (name) => users.has(name),
      getChildList: () => [...new Set([...users.keys(), ...defaults.keys()])],
      getPrefType: (name) =>
        typeof read(name) === "boolean"
          ? 128
          : typeof read(name) === "number"
            ? 64
            : 32,
      getBoolPref: read,
      getIntPref: read,
      getStringPref: read,
      setBoolPref: write,
      setIntPref: write,
      setStringPref: write,
    };
  };
  const prefs = {
    PREF_BOOL: 128,
    PREF_INT: 64,
    PREF_STRING: 32,
    getBranch(prefix) {
      if (prefix === "extensions.zotero.ZoteroPDFTranslate.") {
        return branch(original, originalDefaults, true);
      }
      assert.equal(prefix, `${config.prefsPrefix}.`);
      return branch(custom, customDefaults, false);
    },
    savePrefFile(file) {
      assert.equal(file, null);
      saves.push(new Map(custom));
    },
  };
  const module = { exports: {} };
  new Script(code, { filename: "reliableSetup.fixture.js" }).runInNewContext({
    module,
    exports: module.exports,
    require(id) {
      if (id === "../../package.json") return { config };
      if (id === "../utils/locale") return { getString: (key) => key };
      assert.fail(`Unexpected import: ${id}`);
    },
    Services: {
      prefs,
      prompt: {
        alert(_window, _title, message) {
          if (options.notificationsFail) throw new Error(syntheticSecret);
          notices.push(message);
        },
      },
    },
    ChromeUtils: {
      importESModule(uri) {
        assert.equal(uri, "resource://gre/modules/AddonManager.sys.mjs");
        if (options.statusUnknown) throw new Error(syntheticSecret);
        return {
          AddonManager: {
            AUTOUPDATE_DISABLE: autoUpdateDisable,
            async getAddonByID(id) {
              checkedIDs.push(id);
              if (id === config.addonID) return customAddon;
              assert.equal(id, "zoteropdftranslate@euclpts.com");
              return options.addonMissing ? null : originalAddon;
            },
          },
        };
      },
    },
    ztoolkit: {
      ProgressWindow: class {
        constructor() {
          if (options.notificationsFail) throw new Error(syntheticSecret);
        }
        createLine(line) {
          notices.push(line.text);
          return this;
        }
        show() {
          return this;
        }
      },
    },
    Zotero: {
      getMainWindow: () => null,
      debug: (message) => logs.push(message),
    },
  });
  return {
    run: module.exports.prepareReliableSetup,
    original,
    custom,
    notices,
    logs,
    saves,
    checkedIDs,
    originalAddon,
    customAddon,
    backgroundUpdateWrites,
    autoUpdateDisable,
  };
}

test("migration copies only original user values and saves a completion marker", async () => {
  const f = fixture();
  const before = [...f.original];
  const result = await f.run();
  assert.equal(result.shouldActivate, true);
  assert.equal(result.migrated, true);
  assert.equal(f.custom.get("enableAuto"), false);
  assert.equal(f.custom.get("fontSize"), 14);
  assert.equal(
    f.custom.get("secretObj"),
    JSON.stringify({ fixture: syntheticSecret }),
  );
  assert.equal(f.custom.has("defaultOnly"), false);
  assert.equal(f.custom.get(marker), true);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].get(marker), true);
  assert.deepEqual([...f.original], before);
});

test("explicit custom values including empty strings and false are never overwritten", async () => {
  const f = fixture({
    custom: [
      ["fontSize", 19],
      ["secretObj", ""],
      ["enableAuto", false],
    ],
  });
  await f.run();
  assert.equal(f.custom.get("fontSize"), 19);
  assert.equal(f.custom.get("secretObj"), "");
  assert.equal(f.custom.get("enableAuto"), false);
});

test("repeat startup does not recopy later original changes or resave migration", async () => {
  const f = fixture();
  await f.run();
  f.original.set("targetLanguage", "synthetic-language");
  const second = await f.run();
  assert.equal(second.migrated, false);
  assert.equal(second.shouldActivate, true);
  assert.equal(f.custom.has("targetLanguage"), false);
  assert.equal(f.saves.length, 1);
  assert.equal(
    f.checkedIDs.filter((id) => id === "zoteropdftranslate@euclpts.com").length,
    2,
    "active state must be checked on every startup",
  );
});

test("an active original or unknown status pauses activation while a missing addon is safe", async () => {
  const active = fixture({ originalActive: true });
  assert.equal((await active.run()).shouldActivate, false);
  assert.deepEqual(active.checkedIDs, [
    config.addonID,
    "zoteropdftranslate@euclpts.com",
  ]);
  assert.deepEqual(active.notices, ["reliable-setup-original-active"]);
  const unknown = fixture({ statusUnknown: true });
  assert.equal((await unknown.run()).shouldActivate, false);
  assert.deepEqual(unknown.notices, ["reliable-setup-status-unknown"]);
  assert.equal(
    (await fixture({ addonMissing: true }).run()).shouldActivate,
    true,
  );
});

test("a partial write failure keeps the marker unset and fills only missing values on retry", async () => {
  const f = fixture({ failureName: "fontSize" });
  assert.equal((await f.run()).shouldActivate, false);
  assert.equal(f.custom.has(marker), false);
  assert.equal(f.saves.length, 0);
  f.custom.set("enableAuto", true); // A user change after the partial migration.
  const retried = await f.run();
  assert.equal(retried.shouldActivate, true);
  assert.equal(retried.migrated, true);
  assert.equal(f.custom.get("enableAuto"), true);
  assert.equal(f.custom.get("fontSize"), 14);
  assert.equal(f.custom.get(marker), true);
  assert.equal(f.saves.length, 1);
});

test("normal, exception and notification fallback paths never expose configuration in logs", async () => {
  for (const options of [
    {},
    { failureName: "fontSize" },
    { statusUnknown: true },
    { statusUnknown: true, notificationsFail: true },
  ]) {
    const f = fixture(options);
    const result = await f.run();
    const observable = JSON.stringify({
      result,
      notices: f.notices,
      logs: f.logs,
    });
    assert.equal(observable.includes(syntheticSecret), false);
    assert.equal(observable.includes("secretObj"), false);
  }
});

test("only this custom addon has background updates disabled; the original stays unchanged", async () => {
  for (const originalActive of [false, true]) {
    const f = fixture({ originalActive });
    await f.run();
    assert.equal(f.customAddon.applyBackgroundUpdates, f.autoUpdateDisable);
    assert.equal(f.originalAddon.applyBackgroundUpdates, 1);
    assert.equal(f.originalAddon.isActive, originalActive);
    assert.deepEqual(f.backgroundUpdateWrites, [
      { id: config.addonID, value: f.autoUpdateDisable },
    ]);
  }
});
