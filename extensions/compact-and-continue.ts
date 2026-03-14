import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const TOOL_NAME = "compact_and_continue";
export const AUTO_RESUME_PROMPT = [
  "Compaction completed.",
  "Continue the existing work using the compacted summary and the current todo list.",
  "Resume with the next unfinished or in-progress todo item.",
  "Do not repeat already completed work unless new evidence shows it must be revisited.",
].join(" ");

export type PendingRef = { active: boolean };

type CompactPi = Pick<ExtensionAPI, "sendUserMessage">;
type CompactContext = Pick<ExtensionContext, "hasUI" | "compact" | "ui">;

export function normalizeInstructions(instructions?: string): string | undefined {
  const trimmed = instructions?.trim();
  return trimmed ? trimmed : undefined;
}

export function startCompaction(
  pi: CompactPi,
  ctx: CompactContext,
  pendingRef: PendingRef,
  instructions?: string,
): void {
  if (pendingRef.active) {
    throw new Error("A compact-and-continue run is already in progress");
  }

  pendingRef.active = true;

  if (ctx.hasUI) {
    ctx.ui.notify("Starting compaction. Work will resume automatically afterward.", "info");
  }

  ctx.compact({
    customInstructions: instructions,
    onComplete: () => {
      pendingRef.active = false;

      if (ctx.hasUI) {
        ctx.ui.notify("Compaction finished. Resuming work.", "info");
      }

      pi.sendUserMessage(AUTO_RESUME_PROMPT);
    },
    onError: (error) => {
      pendingRef.active = false;

      if (ctx.hasUI) {
        ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
      }
    },
  });
}

export default function compactAndContinueExtension(pi: ExtensionAPI) {
  const pendingCompaction: PendingRef = { active: false };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Compact & Continue",
    description:
      "Compact the conversation now, then automatically continue the remaining work in a fresh turn.",
    promptSnippet:
      "Compact the current conversation and automatically resume with the remaining todo-driven work.",
    promptGuidelines: [
      "Use this tool only when the user explicitly asked for compaction, or when a todo/control step says to compact the conversation.",
      "Before using this tool, make sure the current work chunk is wrapped up and any todo updates for that chunk are already recorded.",
      "After calling this tool, stop the current turn. A fresh turn will be queued automatically after compaction completes.",
    ],
    parameters: Type.Object({
      instructions: Type.Optional(
        Type.String({
          description:
            "Optional custom instructions for what the compaction summary should preserve or emphasize.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const instructions = normalizeInstructions(params.instructions);
      startCompaction(pi, ctx, pendingCompaction, instructions);

      return {
        content: [
          {
            type: "text",
            text:
              "Compaction has been started. When it finishes, a new turn will automatically continue the remaining work. Stop here and let that resumed turn proceed.",
          },
        ],
        details: {
          started: true,
          instructions,
        },
      };
    },
  });
}
