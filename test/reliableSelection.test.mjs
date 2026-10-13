import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReliableSelectionBindings,
  canReuseSelectionTask,
  normalizeSelectionText,
} from "../src/utils/reliableSelection.ts";

// Runs with Node 22.18+ or Node 24, using built-in TypeScript type stripping.
// No Zotero instance, translation endpoint, credentials or npm dependency needed.
const task = (id, raw, status = "processing", itemId = 1) => ({
  id,
  raw,
  status,
  itemId,
  result: "",
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("PDF line wraps compare equally while punctuation remains significant", () => {
  assert.equal(
    normalizeSelectionText("  H₂\n adsorption\u00A0at\t77 K. "),
    "H2 adsorption at 77 K.",
  );
  assert.notEqual(
    normalizeSelectionText("6.0–6.8 nm"),
    normalizeSelectionText("6.06.8 nm"),
  );
  assert.notEqual(
    normalizeSelectionText("Na2SO3/NaOH"),
    normalizeSelectionText("Na2SO3 NaOH"),
  );
});

test("identical text in two readers has independent error and result ownership", () => {
  const selections = new ReliableSelectionBindings();
  const popupA = {},
    popupB = {};
  const failed = task("reader-a-failed", "The same passage", "fail");
  const good = task("reader-b-good", "The same passage", "success");
  selections.bind("reader-a", failed, popupA);
  selections.bind("reader-b", good, popupB);
  assert.equal(selections.findSame("reader-a", good.raw, 1), failed);
  assert.equal(selections.findSame("reader-b", good.raw, 1), good);
  assert.equal(selections.canRender(failed.id, popupB), false);
  assert.equal(selections.canRender(good.id, popupA), false);
  assert.equal(canReuseSelectionTask(failed), false);
  assert.equal(canReuseSelectionTask(good), true);
});

test("selection reuse also requires the same item and reader", () => {
  const selections = new ReliableSelectionBindings();
  const original = task("original", "a\nparagraph", "processing", 10);
  selections.bind("reader-a", original, {});
  assert.equal(selections.findSame("reader-a", "a paragraph", 10), original);
  assert.equal(selections.findSame("reader-a", "a paragraph", 11), undefined);
  assert.equal(selections.findSame("reader-b", "a paragraph", 10), undefined);
});

test("reopening the same pending selection reuses work and retires the old popup", () => {
  const selections = new ReliableSelectionBindings();
  const oldPopup = {},
    newPopup = {};
  const pending = task("pending", "Same selection");
  const old = selections.bind("reader-a", pending, oldPopup);
  selections.closePopup(oldPopup);
  const same = selections.findSame("reader-a", "Same selection", 1);
  assert.equal(canReuseSelectionTask(same), true);
  const current = selections.bind("reader-a", same, newPopup);
  assert.equal(current.task, pending);
  assert.equal(
    selections.canRender(pending.id, oldPopup, old.generation),
    false,
  );
  assert.equal(
    selections.canRender(pending.id, newPopup, current.generation),
    true,
  );
});

test("reselecting a failed or waiting passage permits a fresh attempt", () => {
  const selections = new ReliableSelectionBindings();
  let created = 0;
  function choose(raw, popup) {
    const previous = selections.findSame("reader", raw, 1);
    const chosen = canReuseSelectionTask(previous)
      ? previous
      : task(`attempt-${++created}`, raw, "waiting");
    selections.bind("reader", chosen, popup);
    return chosen;
  }
  const first = choose("Retry this", {});
  first.status = "fail";
  const second = choose("Retry this", {});
  assert.notEqual(second.id, first.id);
  second.status = "processing";
  assert.equal(choose("Retry this", {}), second);
  second.status = "success";
  assert.equal(choose("Retry this", {}), second);
  second.status = "waiting";
  const third = choose("Retry this", {});
  assert.notEqual(third.id, second.id);
  assert.equal(created, 3);
});

test("late results cannot overwrite a newer passage even when Zotero reuses its popup node", async () => {
  const selections = new ReliableSelectionBindings();
  const popup = { text: "" };
  const old = task("old", "first passage"),
    latest = task("latest", "second passage");
  const response = deferred();
  const binding = selections.bind("reader", old, popup);
  const oldCompletion = response.promise.then((translation) => {
    if (selections.canRender(old.id, popup, binding.generation))
      popup.text = translation;
  });
  selections.bind("reader", latest, popup);
  if (selections.canRender(latest.id, popup)) popup.text = "latest translation";
  response.resolve("late first translation");
  await oldCompletion;
  assert.equal(popup.text, "latest translation");
  assert.equal(selections.findSame("reader", old.raw, 1), undefined);
});

test("same-task popup rebinding can reject an old render generation", () => {
  const selections = new ReliableSelectionBindings();
  const popup = {},
    pending = task("pending", "a passage");
  const original = selections.bind("reader", pending, popup);
  const rebuilt = selections.bind("reader", pending, popup);
  assert.equal(
    selections.canRender(pending.id, popup, original.generation),
    false,
  );
  assert.equal(
    selections.canRender(pending.id, popup, rebuilt.generation),
    true,
  );
});

test("closing popup suppresses late rendering while preserving reusable work", async () => {
  const selections = new ReliableSelectionBindings();
  const popup = { text: "" },
    pending = task("pending", "passage");
  const response = deferred();
  selections.bind("reader", pending, popup);
  const completion = response.promise.then((text) => {
    if (selections.canRender(pending.id, popup)) popup.text = text;
  });
  selections.closePopup(popup);
  response.resolve("must not appear");
  await completion;
  assert.equal(popup.text, "");
  assert.equal(selections.getForPopup(popup), undefined);
  assert.equal(selections.findSame("reader", pending.raw, 1), pending);
});

test("closing a reader drops both its popup and retry context without touching another reader", () => {
  const selections = new ReliableSelectionBindings();
  const popupA = {},
    popupB = {};
  const a = task("a", "passage"),
    b = task("b", "passage");
  selections.bind("reader-a", a, popupA);
  selections.bind("reader-b", b, popupB);
  selections.releaseReader("reader-a");
  assert.equal(selections.canRender(a.id, popupA), false);
  assert.equal(selections.findSame("reader-a", a.raw, 1), undefined);
  assert.equal(selections.canRender(b.id, popupB), true);
});

test("detached DOM nodes and closed windows reject completion even before explicit cleanup", () => {
  const selections = new ReliableSelectionBindings();
  const popup = { isConnected: true },
    window = { closed: false };
  const a = task("a", "one"),
    b = task("b", "two");
  selections.bind("node-reader", a, popup);
  selections.bind("window-reader", b, window);
  popup.isConnected = false;
  window.closed = true;
  assert.equal(selections.canRender(a.id, popup), false);
  assert.equal(selections.canRender(b.id, window), false);
  popup.isConnected = true;
  assert.equal(selections.canRender(a.id, popup), false);
});

test("a popup transferred to another reader does not leave a stale owner", () => {
  const selections = new ReliableSelectionBindings();
  const popup = {},
    a = task("a", "one"),
    b = task("b", "two");
  selections.bind("reader-a", a, popup);
  selections.bind("reader-b", b, popup);
  selections.releaseReader("reader-a");
  assert.equal(selections.findSame("reader-a", a.raw, 1), undefined);
  assert.equal(selections.getForPopup(popup).task, b);
});

test("clear retires every binding and selected-text snapshots do not follow task mutation", () => {
  const selections = new ReliableSelectionBindings();
  const popup = {},
    selected = task("a", "original", "processing", 10);
  selections.bind("reader", selected, popup);
  selected.raw = "task edited later";
  selected.itemId = 20;
  assert.equal(selections.findSame("reader", "original", 10), selected);
  assert.equal(selections.findSame("reader", selected.raw, 20), undefined);
  selections.clear();
  assert.equal(selections.findSame("reader", "original", 10), undefined);
  assert.equal(selections.canRender(selected.id, popup), false);
});

test("current reader task can be cancelled after its popup is dismissed without touching another reader", () => {
  const selections = new ReliableSelectionBindings();
  const popup = {},
    first = task("first", "one"),
    second = task("second", "two");
  selections.bind("reader-a", first, popup);
  selections.bind("reader-b", second, {});
  selections.closePopup(popup);
  assert.equal(selections.getCurrentTask("reader-a"), first);
  selections.releaseReader("reader-a");
  assert.equal(selections.getCurrentTask("reader-a"), undefined);
  assert.equal(selections.getCurrentTask("reader-b"), second);
  selections.clear();
  assert.equal(selections.getCurrentTask("reader-b"), undefined);
});
