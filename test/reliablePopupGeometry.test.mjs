import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampPopupRect,
  resizePopupRect,
  movePopupRect,
  normalizeWheelDelta,
} from "../src/utils/reliablePopupGeometry.ts";

const viewport = { width: 900, height: 700 };
const limits = { minWidth: 180, minHeight: 140, margin: 8 };
const start = { left: 120, top: 100, width: 260, height: 220 };
const edges = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const right = (rect) => rect.left + rect.width;
const bottom = (rect) => rect.top + rect.height;

function assertFits(rect, view) {
  for (const value of Object.values(rect)) assert.ok(Number.isFinite(value));
  assert.ok(rect.left >= -1e-9 && rect.top >= -1e-9);
  assert.ok(rect.width >= 0 && rect.height >= 0);
  assert.ok(right(rect) <= Math.max(0, view.width) + 1e-9);
  assert.ok(bottom(rect) <= Math.max(0, view.height) + 1e-9);
}

function assertAnchored(initial, resized, edge) {
  if (edge.includes("w")) assert.equal(right(resized), right(initial));
  else assert.equal(resized.left, initial.left);
  if (edge.includes("n")) assert.equal(bottom(resized), bottom(initial));
  else assert.equal(resized.top, initial.top);
  if (!edge.includes("w") && !edge.includes("e"))
    assert.equal(resized.width, initial.width);
  if (!edge.includes("n") && !edge.includes("s"))
    assert.equal(resized.height, initial.height);
}

test("an already valid rectangle keeps its exact position and preferred size", () => {
  assert.deepEqual(clampPopupRect(start, viewport, limits), start);
});

test("clamping handles size and position together at all four viewport boundaries", () => {
  assert.deepEqual(
    clampPopupRect(
      { left: -100, top: -30, width: 60, height: 40 },
      viewport,
      limits,
    ),
    { left: 8, top: 8, width: 180, height: 140 },
  );
  assert.deepEqual(
    clampPopupRect(
      { left: 850, top: 680, width: 260, height: 220 },
      viewport,
      limits,
    ),
    { left: 632, top: 472, width: 260, height: 220 },
  );
  assert.deepEqual(
    clampPopupRect(
      { left: 100, top: 100, width: 2000, height: 2000 },
      viewport,
      limits,
    ),
    { left: 8, top: 8, width: 884, height: 684 },
  );
});

test("every edge and corner changes only the dragged sides", () => {
  const expected = {
    n: { left: 120, top: 150, width: 260, height: 170 },
    ne: { left: 120, top: 150, width: 300, height: 170 },
    e: { left: 120, top: 100, width: 300, height: 220 },
    se: { left: 120, top: 100, width: 300, height: 270 },
    s: { left: 120, top: 100, width: 260, height: 270 },
    sw: { left: 160, top: 100, width: 220, height: 270 },
    w: { left: 160, top: 100, width: 220, height: 220 },
    nw: { left: 160, top: 150, width: 220, height: 170 },
  };
  for (const edge of edges) {
    const result = resizePopupRect(start, edge, 40, 50, viewport, limits);
    assert.deepEqual(result, expected[edge], edge);
    assertAnchored(start, result, edge);
    assertFits(result, viewport);
  }
});

test("left and top can grow up to the boundary without moving their opposite edges", () => {
  const result = resizePopupRect(start, "nw", -10000, -10000, viewport, limits);
  assert.deepEqual(result, { left: 8, top: 8, width: 372, height: 312 });
  assertAnchored(start, result, "nw");
});

test("right and bottom can grow up to the boundary without moving the origin", () => {
  const result = resizePopupRect(start, "se", 10000, 10000, viewport, limits);
  assert.deepEqual(result, { left: 120, top: 100, width: 772, height: 592 });
  assertAnchored(start, result, "se");
});

test("crossing an opposite edge stops at the minimum instead of flipping the rectangle", () => {
  assert.deepEqual(
    resizePopupRect(start, "nw", 10000, 10000, viewport, limits),
    { left: 200, top: 180, width: 180, height: 140 },
  );
  assert.deepEqual(
    resizePopupRect(start, "se", -10000, -10000, viewport, limits),
    { left: 120, top: 100, width: 180, height: 140 },
  );
});

test("tiny viewports reduce margins and effective minimums rather than overflow", () => {
  const small = { width: 100, height: 60 };
  const largeMinimums = { minWidth: 240, minHeight: 160, margin: 8 };
  const initial = clampPopupRect(start, small, largeMinimums);
  assert.deepEqual(initial, { left: 0, top: 0, width: 100, height: 60 });
  for (const edge of edges) {
    const resized = resizePopupRect(
      start,
      edge,
      2000,
      -2000,
      small,
      largeMinimums,
    );
    assert.deepEqual(resized, initial);
    assertFits(resized, small);
  }
  assert.deepEqual(clampPopupRect(start, { width: 190, height: 150 }, limits), {
    left: 5,
    top: 5,
    width: 180,
    height: 140,
  });
});

test("zero-sized viewports produce a finite empty rectangle", () => {
  assert.deepEqual(clampPopupRect(start, { width: 0, height: 0 }, limits), {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  for (const edge of edges)
    assert.deepEqual(
      resizePopupRect(start, edge, -100, 100, { width: 0, height: 0 }, limits),
      { left: 0, top: 0, width: 0, height: 0 },
    );
});

test("invalid numeric input has safe fallbacks and an invalid edge does not resize", () => {
  const invalid = { left: NaN, top: Infinity, width: -100, height: NaN };
  assert.deepEqual(clampPopupRect(invalid, viewport, limits), {
    left: 8,
    top: 8,
    width: 180,
    height: 140,
  });
  assert.deepEqual(
    resizePopupRect(start, "se", NaN, Infinity, viewport, limits),
    start,
  );
  assert.deepEqual(
    resizePopupRect(start, "unknown", 100, 100, viewport, limits),
    start,
  );
  assert.deepEqual(
    clampPopupRect(
      invalid,
      { width: NaN, height: -1 },
      { minWidth: NaN, minHeight: Infinity, margin: -50 },
    ),
    { left: 0, top: 0, width: 0, height: 0 },
  );
});

test("all drag directions remain anchored and bounded across sizes and deltas", () => {
  for (const view of [
    { width: 900, height: 700 },
    { width: 245, height: 161 },
    { width: 37, height: 21 },
  ]) {
    for (const initialInput of [
      start,
      { left: -40, top: 1000, width: 999, height: 1000 },
      { left: 20, top: 30, width: 181, height: 142 },
    ]) {
      const initial = clampPopupRect(initialInput, view, limits);
      for (const edge of edges)
        for (const dx of [-2000, -0.25, 0, 0.125, 2000])
          for (const dy of [-2000, -0.25, 0, 0.125, 2000]) {
            const resized = resizePopupRect(
              initialInput,
              edge,
              dx,
              dy,
              view,
              limits,
            );
            assertFits(resized, view);
            assertAnchored(initial, resized, edge);
          }
    }
  }
});

test("wheel delta supports pixel, line and page units with preserved direction", () => {
  assert.equal(normalizeWheelDelta(2.5, 0, 18, 300), 2.5);
  assert.equal(normalizeWheelDelta(-2, 1, 18, 300), -36);
  assert.equal(normalizeWheelDelta(0.5, 2, 18, 300), 150);
  assert.equal(normalizeWheelDelta(-1.5, 2, 18, 300), -450);
});

test("moving changes only position and preserves subpixel displacement", () => {
  assert.deepEqual(movePopupRect(start, 40.5, -20.25, viewport, limits), {
    left: 160.5,
    top: 79.75,
    width: 260,
    height: 220,
  });
  assert.deepEqual(movePopupRect(start, 0, 0, viewport, limits), start);
});

test("moving to each boundary clamps position without squeezing the popup", () => {
  assert.deepEqual(movePopupRect(start, -10000, -10000, viewport, limits), {
    left: 8,
    top: 8,
    width: 260,
    height: 220,
  });
  assert.deepEqual(movePopupRect(start, 10000, 10000, viewport, limits), {
    left: 632,
    top: 472,
    width: 260,
    height: 220,
  });
  assert.deepEqual(movePopupRect(start, -10000, 10000, viewport, limits), {
    left: 8,
    top: 472,
    width: 260,
    height: 220,
  });
  assert.deepEqual(movePopupRect(start, 10000, -10000, viewport, limits), {
    left: 632,
    top: 8,
    width: 260,
    height: 220,
  });
});

test("non-finite move deltas are ignored independently and large finite deltas remain bounded", () => {
  assert.deepEqual(
    movePopupRect(start, NaN, Infinity, viewport, limits),
    start,
  );
  assert.deepEqual(movePopupRect(start, -Infinity, 20, viewport, limits), {
    ...start,
    top: 120,
  });
  assert.deepEqual(movePopupRect(start, 30, NaN, viewport, limits), {
    ...start,
    left: 150,
  });
  const moved = movePopupRect(
    start,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    viewport,
    limits,
  );
  assert.deepEqual(moved, { left: 632, top: 8, width: 260, height: 220 });
  assertFits(moved, viewport);
});

test("tiny and zero viewports move only the already fitted rectangle without overflow", () => {
  for (const view of [
    { width: 100, height: 60 },
    { width: 0, height: 0 },
  ]) {
    const fitted = clampPopupRect(start, view, limits);
    for (const dx of [-1000, 0, 1000])
      for (const dy of [-1000, 0, 1000]) {
        const moved = movePopupRect(start, dx, dy, view, limits);
        assert.equal(moved.width, fitted.width);
        assert.equal(moved.height, fitted.height);
        assertFits(moved, view);
      }
  }
});

test("trackpad fractions are not rounded and anomalous wheel values stay finite", () => {
  assert.equal(normalizeWheelDelta(0.125, 0, 18, 300), 0.125);
  assert.equal(normalizeWheelDelta(-0.0078125, 0, 18, 300), -0.0078125);
  assert.equal(normalizeWheelDelta(0.125, 1, 18, 300), 2.25);
  assert.equal(normalizeWheelDelta(NaN, 1, 18, 300), 0);
  assert.equal(normalizeWheelDelta(2, 1, NaN, 300), 32);
  assert.equal(normalizeWheelDelta(2, 2, 18, NaN), 36);
  assert.equal(normalizeWheelDelta(0.5, 99, 18, 300), 0.5);
  assert.ok(Number.isFinite(normalizeWheelDelta(Number.MAX_VALUE, 2, 18, 300)));
});
