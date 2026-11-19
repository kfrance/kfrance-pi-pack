/**
 * Image Generation Extension
 *
 * Wraps the `imagegen` CLI tool (from kl-tools) as pi tools so the LLM
 * can generate and edit images directly.
 *
 * Prerequisites:
 *   - `imagegen` CLI installed: `uv tool install -e ~/kl-tools`
 *   - API key configured: OPENROUTER_API_KEY or OPENAI_API_KEY
 *     (env var or in ~/.config/kl-tools/.env)
 *
 * Registers tools:
 *   - imagegen_generate: Generate an image from a text prompt
 *   - imagegen_edit: Edit an existing image with a text prompt
 *   - imagegen_models: List available image generation models
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

interface ImagegenResult {
  success: boolean;
  output_path?: string;
  model?: string;
  backend?: string;
  prompt?: string;
  format?: string;
  error?: string;
  error_code?: string;
  models?: Array<{ id: string; name?: string }>;
}

function parseResult(stdout: string, stderr: string, code: number | null): ImagegenResult {
  try {
    return JSON.parse(stdout);
  } catch {
    return {
      success: false,
      error: stderr || stdout || `Process exited with code ${code}`,
      error_code: "parse_error",
    };
  }
}

export default function (pi: ExtensionAPI) {
  // Generate image from prompt
  pi.registerTool({
    name: "imagegen_generate",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt using AI models. " +
      "Output format is determined by file extension (png, jpg, webp). " +
      "Default backend: openrouter. Default model: google/gemini-2.5-flash-image.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Text description of the image to generate" }),
      output_path: Type.String({ description: "Output file path (e.g., output.png). Format determined by extension." }),
      model: Type.Optional(Type.String({ description: "Model to use (run imagegen_models to see options)" })),
      backend: Type.Optional(StringEnum(["openrouter", "openai"] as const, { description: "Backend to use (default: openrouter)" })),
      timeout: Type.Optional(Type.Number({ description: "Request timeout in seconds (default: 120)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = ["generate", params.prompt, params.output_path];
      if (params.model) args.push("--model", params.model);
      if (params.backend) args.push("--backend", params.backend);
      if (params.timeout) args.push("--timeout", String(params.timeout));

      const result = await pi.exec("imagegen", args, { signal, timeout: (params.timeout ?? 120) * 1000 + 5000 });
      const parsed = parseResult(result.stdout, result.stderr, result.code);

      if (parsed.success) {
        return {
          content: [
            { type: "text", text: `Image generated: ${parsed.output_path} (model: ${parsed.model}, backend: ${parsed.backend})` },
          ],
          details: parsed,
        };
      } else {
        return {
          content: [{ type: "text", text: `Image generation failed: ${parsed.error} (${parsed.error_code})` }],
          details: parsed,
          isError: true,
        };
      }
    },
  });

  // Edit existing image
  pi.registerTool({
    name: "imagegen_edit",
    label: "Edit Image",
    description:
      "Edit an existing image using a text prompt. " +
      "For true image editing that uses the input image, use backend 'openai'. " +
      "The openrouter backend generates a new image based on the prompt without using the input.",
    parameters: Type.Object({
      input_path: Type.String({ description: "Path to the input image to edit" }),
      prompt: Type.String({ description: "Text description of the edit to apply" }),
      output_path: Type.String({ description: "Output file path for the edited image" }),
      model: Type.Optional(Type.String({ description: "Model to use" })),
      backend: Type.Optional(StringEnum(["openrouter", "openai"] as const, { description: "Backend to use (default: openrouter)" })),
      timeout: Type.Optional(Type.Number({ description: "Request timeout in seconds (default: 120)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = ["edit", params.input_path, params.prompt, params.output_path];
      if (params.model) args.push("--model", params.model);
      if (params.backend) args.push("--backend", params.backend);
      if (params.timeout) args.push("--timeout", String(params.timeout));

      const result = await pi.exec("imagegen", args, { signal, timeout: (params.timeout ?? 120) * 1000 + 5000 });
      const parsed = parseResult(result.stdout, result.stderr, result.code);

      if (parsed.success) {
        return {
          content: [
            { type: "text", text: `Image edited: ${parsed.output_path} (model: ${parsed.model}, backend: ${parsed.backend})` },
          ],
          details: parsed,
        };
      } else {
        return {
          content: [{ type: "text", text: `Image edit failed: ${parsed.error} (${parsed.error_code})` }],
          details: parsed,
          isError: true,
        };
      }
    },
  });

  // List available models
  pi.registerTool({
    name: "imagegen_models",
    label: "List Image Models",
    description: "List available image generation models for a backend.",
    parameters: Type.Object({
      backend: Type.Optional(StringEnum(["openrouter", "openai"] as const, { description: "Backend to query (default: openrouter)" })),
      refresh: Type.Optional(Type.Boolean({ description: "Force refresh from API, ignoring cache" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = ["models"];
      if (params.backend) args.push("--backend", params.backend);
      if (params.refresh) args.push("--refresh");

      const result = await pi.exec("imagegen", args, { signal, timeout: 30000 });
      const parsed = parseResult(result.stdout, result.stderr, result.code);

      if (parsed.success) {
        return {
          content: [{ type: "text", text: result.stdout }],
          details: parsed,
        };
      } else {
        return {
          content: [{ type: "text", text: `Failed to list models: ${parsed.error}` }],
          details: parsed,
          isError: true,
        };
      }
    },
  });
}
