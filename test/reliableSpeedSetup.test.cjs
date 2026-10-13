const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");

function fixture(current = "cnki") {
  const prefs = new Map([["translateSource", current]]);
  let saves = 0;
  const module = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(
      path.join(__dirname, "../src/modules/reliableSpeedSetup.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id) => {
      assert.equal(id, "../../package.json");
      return { config: { prefsPrefix: "extensions.zotero.ReliableTranslate" } };
    },
    Services: {
      prefs: {
        getBranch(prefix) {
          assert.equal(prefix, "extensions.zotero.ReliableTranslate.");
          return {
            getBoolPref: (key, fallback) => prefs.get(key) ?? fallback,
            getStringPref: (key, fallback) => prefs.get(key) ?? fallback,
            setBoolPref: (key, value) => prefs.set(key, value),
            setStringPref: (key, value) => prefs.set(key, value),
          };
        },
        savePrefFile(file) {
          assert.equal(file, null);
          saves++;
        },
      },
    },
  });
  return {
    prefs,
    run: module.exports.applyReliableSpeedUpgrade,
    saves: () => saves,
  };
}

test("upgrade replaces the old default once and keeps the previous source for reference", () => {
  const f = fixture();
  f.run();
  assert.equal(f.prefs.get("translateSource"), "bing");
  assert.equal(f.prefs.get("reliableSpeed.previousSource"), "cnki");
  assert.equal(f.saves(), 1);
});

test("an explicit source choice after upgrade survives later startups", () => {
  const f = fixture();
  f.run();
  f.prefs.set("translateSource", "tencenttransmart");
  f.run();
  assert.equal(f.prefs.get("translateSource"), "tencenttransmart");
  assert.equal(f.saves(), 1);
});

test("existing nondefault configured providers stay intact", () => {
  const f = fixture("chatgpt");
  f.run();
  assert.equal(f.prefs.get("translateSource"), "chatgpt");
  assert.equal(f.prefs.has("reliableSpeed.previousSource"), false);
});

test("an unset default becomes Bing without touching credentials or word settings", () => {
  const f = fixture("");
  f.prefs.set("dictSource", "bingdict");
  f.prefs.set("secretObj", "synthetic-config");
  f.run();
  assert.equal(f.prefs.get("translateSource"), "bing");
  assert.equal(f.prefs.get("dictSource"), "bingdict");
  assert.equal(f.prefs.get("secretObj"), "synthetic-config");
});
