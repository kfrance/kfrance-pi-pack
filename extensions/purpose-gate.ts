/**
 * Purpose Gate Extension
 *
 * On new session startup, prompts the user: "What is the purpose of this session?"
 * Stores the answer, displays it in a permanent widget above the editor,
 * and allows editing via /purpose command.
 *
 * State is persisted via appendEntry so it survives restarts and session switches.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const ENTRY_TYPE = "purpose-gate";
export const WIDGET_ID = "purpose-gate";

/**
 * Reconstruct the most recent purpose from session entries.
 */
export function reconstructPurpose(entries: Array<{ type: string; customType?: string; data?: any }>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data?.purpose) {
      return entry.data.purpose;
    }
  }
  return null;
}

/**
 * Format the widget lines for display.
 */
export function formatWidgetLines(purpose: string): string[] {
  return [`🎯 ${purpose}`];
}

function applyWidget(ctx: ExtensionContext, purpose: string | null) {
  if (!ctx.hasUI) return;
  if (purpose) {
    ctx.ui.setWidget(WIDGET_ID, formatWidgetLines(purpose));
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

async function promptForPurpose(ctx: ExtensionContext): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  return await ctx.ui.input("What is the purpose of this session?", "e.g., Refactor auth module");
}

export default function (pi: ExtensionAPI) {
  let currentPurpose: string | null = null;

  const restoreAndDisplay = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    currentPurpose = reconstructPurpose(entries);
    applyWidget(ctx, currentPurpose);
  };

  /** Fire-and-forget: prompt for purpose then persist + display. */
  const promptAndSave = (ctx: ExtensionContext) => {
    promptForPurpose(ctx).then((answer) => {
      if (answer && answer.trim()) {
        currentPurpose = answer.trim();
        pi.appendEntry(ENTRY_TYPE, { purpose: currentPurpose });
        applyWidget(ctx, currentPurpose);
      }
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    restoreAndDisplay(ctx);

    // Prompt if no purpose yet. Don't await — session_start blocks TUI init,
    // so the input dialog would never receive keyboard events.
    if (!currentPurpose) {
      promptAndSave(ctx);
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    restoreAndDisplay(ctx);

    // session_switch doesn't block TUI init, but use the same pattern for consistency
    if (!currentPurpose) {
      promptAndSave(ctx);
    }
  });

  pi.on("session_fork", async (_event, ctx) => {
    restoreAndDisplay(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreAndDisplay(ctx);
  });

  pi.registerCommand("purpose", {
    description: "View or edit the session purpose",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/purpose requires interactive mode", "error");
        return;
      }

      // If args provided directly, use them as the new purpose
      if (args && args.trim()) {
        currentPurpose = args.trim();
        pi.appendEntry(ENTRY_TYPE, { purpose: currentPurpose });
        applyWidget(ctx, currentPurpose);
        ctx.ui.notify(`Purpose updated: ${currentPurpose}`, "info");
        return;
      }

      // No args — prompt with current value pre-filled
      const answer = await ctx.ui.input(
        "Session purpose:",
        currentPurpose ?? "e.g., Refactor auth module",
      );

      if (answer !== undefined && answer.trim()) {
        currentPurpose = answer.trim();
        pi.appendEntry(ENTRY_TYPE, { purpose: currentPurpose });
        applyWidget(ctx, currentPurpose);
        ctx.ui.notify(`Purpose updated: ${currentPurpose}`, "info");
      }
    },
  });
}
