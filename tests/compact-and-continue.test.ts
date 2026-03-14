import { describe, it } from "node:test";
import assert from "node:assert";
import compactAndContinueExtension, {
  AUTO_RESUME_PROMPT,
  TOOL_NAME,
  normalizeInstructions,
  startCompaction,
} from "../extensions/compact-and-continue.ts";

describe("compact-and-continue", () => {
  describe("normalizeInstructions", () => {
    it("trims non-empty instructions", () => {
      assert.strictEqual(normalizeInstructions("  focus on todos  "), "focus on todos");
    });

    it("returns undefined for blank instructions", () => {
      assert.strictEqual(normalizeInstructions("   \n  "), undefined);
      assert.strictEqual(normalizeInstructions(undefined), undefined);
    });
  });

  describe("startCompaction", () => {
    it("throws when another run is already active", () => {
      const pendingRef = { active: true };
      const pi = { sendUserMessage() {} } as any;
      const ctx = {
        hasUI: false,
        ui: { notify() {} },
        compact() {},
      } as any;

      assert.throws(() => startCompaction(pi, ctx, pendingRef), /already in progress/);
    });

    it("starts compaction and resumes work on completion", () => {
      const notifications: Array<{ message: string; level: string }> = [];
      const sentMessages: string[] = [];
      const pendingRef = { active: false };
      let compactOptions: any;

      const pi = {
        sendUserMessage(message: string) {
          sentMessages.push(message);
        },
      } as any;
      const ctx = {
        hasUI: true,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        compact(options: any) {
          compactOptions = options;
        },
      } as any;

      startCompaction(pi, ctx, pendingRef, "focus on current todo state");

      assert.strictEqual(pendingRef.active, true);
      assert.deepStrictEqual(notifications, [
        {
          message: "Starting compaction. Work will resume automatically afterward.",
          level: "info",
        },
      ]);
      assert.strictEqual(compactOptions.customInstructions, "focus on current todo state");

      compactOptions.onComplete();

      assert.strictEqual(pendingRef.active, false);
      assert.deepStrictEqual(sentMessages, [AUTO_RESUME_PROMPT]);
      assert.deepStrictEqual(notifications, [
        {
          message: "Starting compaction. Work will resume automatically afterward.",
          level: "info",
        },
        {
          message: "Compaction finished. Resuming work.",
          level: "info",
        },
      ]);
    });

    it("clears pending state and reports errors when compaction fails", () => {
      const notifications: Array<{ message: string; level: string }> = [];
      const sentMessages: string[] = [];
      const pendingRef = { active: false };
      let compactOptions: any;

      const pi = {
        sendUserMessage(message: string) {
          sentMessages.push(message);
        },
      } as any;
      const ctx = {
        hasUI: true,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
        compact(options: any) {
          compactOptions = options;
        },
      } as any;

      startCompaction(pi, ctx, pendingRef);
      compactOptions.onError(new Error("boom"));

      assert.strictEqual(pendingRef.active, false);
      assert.deepStrictEqual(sentMessages, []);
      assert.deepStrictEqual(notifications, [
        {
          message: "Starting compaction. Work will resume automatically afterward.",
          level: "info",
        },
        {
          message: "Compaction failed: boom",
          level: "error",
        },
      ]);
    });
  });

  describe("extension registration", () => {
    it("registers the compact_and_continue tool", () => {
      const registeredTools: any[] = [];
      const pi = {
        registerTool(definition: any) {
          registeredTools.push(definition);
        },
      } as any;

      compactAndContinueExtension(pi);

      assert.strictEqual(registeredTools.length, 1);
      assert.strictEqual(registeredTools[0].name, TOOL_NAME);
      assert.strictEqual(registeredTools[0].label, "Compact & Continue");
    });
  });
});
