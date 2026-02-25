import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  reconstructPurpose,
  formatWidgetLines,
  ENTRY_TYPE,
  WIDGET_ID,
} from "../extensions/purpose-gate.ts";

// ---------------------------------------------------------------------------
// reconstructPurpose
// ---------------------------------------------------------------------------

describe("reconstructPurpose", () => {
  it("returns null for empty entries", () => {
    assert.strictEqual(reconstructPurpose([]), null);
  });

  it("returns null when no purpose entries exist", () => {
    const entries = [
      { type: "message" },
      { type: "custom", customType: "other-extension", data: { foo: "bar" } },
    ];
    assert.strictEqual(reconstructPurpose(entries), null);
  });

  it("returns the purpose from a single entry", () => {
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { purpose: "Build auth module" } },
    ];
    assert.strictEqual(reconstructPurpose(entries), "Build auth module");
  });

  it("returns the most recent purpose when multiple exist", () => {
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { purpose: "First purpose" } },
      { type: "message" },
      { type: "custom", customType: ENTRY_TYPE, data: { purpose: "Updated purpose" } },
    ];
    assert.strictEqual(reconstructPurpose(entries), "Updated purpose");
  });

  it("ignores entries with matching customType but no purpose in data", () => {
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: {} },
    ];
    assert.strictEqual(reconstructPurpose(entries), null);
  });

  it("ignores entries with matching customType but undefined data", () => {
    const entries = [
      { type: "custom", customType: ENTRY_TYPE },
    ];
    assert.strictEqual(reconstructPurpose(entries), null);
  });

  it("returns earlier purpose when latest entry has no purpose", () => {
    const entries = [
      { type: "custom", customType: ENTRY_TYPE, data: { purpose: "Good one" } },
      { type: "custom", customType: ENTRY_TYPE, data: {} },
    ];
    assert.strictEqual(reconstructPurpose(entries), "Good one");
  });

  it("skips non-custom entry types", () => {
    const entries = [
      { type: "message", customType: ENTRY_TYPE, data: { purpose: "Nope" } },
      { type: "custom", customType: ENTRY_TYPE, data: { purpose: "Yes" } },
    ];
    assert.strictEqual(reconstructPurpose(entries), "Yes");
  });
});

// ---------------------------------------------------------------------------
// formatWidgetLines
// ---------------------------------------------------------------------------

describe("formatWidgetLines", () => {
  it("returns an array with a single formatted line", () => {
    const lines = formatWidgetLines("Refactor auth module");
    assert.deepStrictEqual(lines, ["🎯 Refactor auth module"]);
  });

  it("includes the full purpose text", () => {
    const purpose = "Build a dashboard with charts and filters";
    const lines = formatWidgetLines(purpose);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes(purpose));
  });

  it("handles short purposes", () => {
    const lines = formatWidgetLines("Fix bug");
    assert.deepStrictEqual(lines, ["🎯 Fix bug"]);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("ENTRY_TYPE is a non-empty string", () => {
    assert.strictEqual(typeof ENTRY_TYPE, "string");
    assert.ok(ENTRY_TYPE.length > 0);
  });

  it("WIDGET_ID is a non-empty string", () => {
    assert.strictEqual(typeof WIDGET_ID, "string");
    assert.ok(WIDGET_ID.length > 0);
  });
});
