#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GmiClient, type GmiRequest } from "./gmi.js";
import { downloadOutcome, expandHome, resolveReferences, type SavedMedia } from "./media.js";
import { loadPresets } from "./presets.js";

// ---- config ---------------------------------------------------------------
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(projectRoot, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile); // doesn't override vars already set by the MCP client
  } catch {
    /* ignore */
  }
}

const cfg = {
  apiKey: process.env.GMI_API_KEY ?? "",
  baseUrl: process.env.GMI_BASE_URL || "https://console.gmicloud.ai",
  defaultModel: process.env.GMI_DEFAULT_MODEL || "gpt-image-2.6-sunburst-generate",
  modelsFile: process.env.GMI_MODELS_FILE ? expandHome(process.env.GMI_MODELS_FILE) : path.join(projectRoot, "models.json"),
  outputDir: process.env.GMI_OUTPUT_DIR || path.join(os.homedir(), "Pictures", "gmi-mcp"),
  timeoutSeconds: Number(process.env.GMI_TIMEOUT_SECONDS) || 300,
  pollIntervalMs: Number(process.env.GMI_POLL_INTERVAL_MS) || 2000,
  maxInlineBytes: Number(process.env.GMI_MAX_INLINE_BYTES) || 4_000_000,
};

const log = (...a: unknown[]) => console.error("[gmiapi-mcp]", ...a); // stdout is reserved for MCP
const presets = loadPresets(cfg.modelsFile, log);
const presetSummary = Object.keys(presets).length
  ? " Models with preset defaults: " + Object.keys(presets).join(", ") + "."
  : "";

let client: GmiClient | undefined;
function gmi(): GmiClient {
  client ??= new GmiClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  return client;
}

// ---- helpers --------------------------------------------------------------
function fail(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  log("error:", msg);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function summarize(req: GmiRequest, saved: SavedMedia[]) {
  return {
    request_id: req.request_id,
    model: req.model,
    status: req.status,
    files: saved.map((s) => ({ path: s.file, url: s.url, mime_type: s.mimeType, bytes: s.bytes })),
    ...(saved.length === 0 && req.outcome ? { outcome: req.outcome } : {}),
    ...(req.status === "failed" || req.status === "cancelled" ? { detail: req } : {}),
  };
}

function resultContent(req: GmiRequest, saved: SavedMedia[], inline: boolean): CallToolResult {
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(summarize(req, saved), null, 2) },
  ];
  if (inline) {
    for (const s of saved) if (s.data) content.push({ type: "image", data: s.data, mimeType: s.mimeType });
  }
  return { content, isError: req.status === "failed" || req.status === "cancelled" };
}

async function runAndCollect(
  model: string,
  payload: Record<string, unknown>,
  opts: { wait: boolean; timeoutSeconds?: number; outputDir?: string; inline: boolean },
): Promise<CallToolResult> {
  const c = gmi();
  log(`submit model=${model}`);
  let req = await c.submit(model, payload);
  log(`request_id=${req.request_id} status=${req.status}`);

  if (!opts.wait && req.status !== "success") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { request_id: req.request_id, model: req.model ?? model, status: req.status, hint: "Call get_request with this request_id to fetch the result." },
            null,
            2,
          ),
        },
      ],
    };
  }
  if (req.status !== "success" && req.status !== "failed" && req.status !== "cancelled") {
    req = await c.waitFor(req.request_id, {
      timeoutMs: (opts.timeoutSeconds ?? cfg.timeoutSeconds) * 1000,
      intervalMs: cfg.pollIntervalMs,
      onPoll: (r) => log(`poll ${r.request_id} -> ${r.status}`),
    });
  }
  req.model ??= model;
  const saved = req.status === "success" ? await downloadOutcome(req, opts.outputDir ?? cfg.outputDir, cfg.maxInlineBytes) : [];
  return resultContent(req, saved, opts.inline);
}

// ---- server ---------------------------------------------------------------
const server = new McpServer({ name: "gmiapi-mcp", version: "0.1.0" });

const commonRunOptions = {
  wait: z.boolean().optional().describe("Wait for completion and download results (default true). false = return request_id immediately."),
  timeout_seconds: z.number().int().positive().optional().describe(`Max seconds to wait (default ${cfg.timeoutSeconds}).`),
  output_dir: z.string().optional().describe(`Folder to save results (default ${cfg.outputDir}).`),
  return_image: z.boolean().optional().describe("Also return the image inline so the assistant can see it (default true)."),
};

server.registerTool(
  "generate_image",
  {
    title: "Generate image (GMI Cloud)",
    description:
      "Generate or edit images with a GMI Cloud model. To edit, pass reference_images (and optionally mask or markup); a gpt-image *-generate model is automatically switched to its *-edit sibling. Model examples (e.g. gpt-image-2.6-sunburst-generate, gpt-image-2-generate, seedream-4-0-250828, gemini-3-pro-image, flux-kontext-pro). " +
      "Saves the files locally and returns their paths, URLs and an inline preview. " +
      "quality/n/output_format/output_compression/background/moderation/complexity/frame_count/frame_duration_ms/safety_identifier are gpt-image style fields; other model-specific options go in extra_params " +
      "(check the model's GMI docs or get_model). Per-model defaults from models.json are applied first." +
      presetSummary,
    inputSchema: {
      prompt: z.string().min(1).describe("Text prompt describing the image or the edit."),
      model: z.string().optional().describe(`GMI model id (default ${cfg.defaultModel}). Use list_models to see options.`),
      size: z.string().optional().describe('Output size, e.g. "1024x1024", "1536x1024", "2048x2048", or a model preset like "2K".'),
      quality: z
        .enum(["low", "medium", "high", "xhigh", "max", "auto"])
        .optional()
        .describe("gpt-image quality tier. Strongly affects price; auto is billed at the max tier on GMI."),
      n: z.number().int().min(1).max(10).optional().describe("Number of images to generate."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).optional().describe("Output file format (gpt-image)."),
      output_compression: z.number().int().min(0).max(100).optional().describe("0-100, jpeg/webp only (gpt-image)."),
      background: z.enum(["auto", "opaque", "transparent"]).optional().describe("Background mode (gpt-image)."),
      moderation: z.enum(["auto", "low"]).optional().describe("Moderation strictness (gpt-image)."),
      complexity: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("gpt-image-2.6 planning depth: low for simple scenes/edits, high for dense text or complex layouts (slower, no extra fee)."),
      frame_count: z.number().int().min(2).max(16).optional().describe("gif only: number of frames (2-16, default 9). Requires n=1."),
      frame_duration_ms: z.number().int().min(20).optional().describe("gif only: ms per frame (default 200)."),
      safety_identifier: z.string().max(128).optional().describe("Stable hashed end-user id for abuse monitoring (gpt-image)."),
      reference_images: z
        .array(z.string())
        .optional()
        .describe("Reference/input images for editing or image-to-image: http(s) URLs or local file paths (local files are uploaded automatically)."),
      mask: z
        .string()
        .optional()
        .describe("Inpainting mask (URL or local PNG with alpha; transparent pixels get edited). Edit models only."),
      markup: z
        .string()
        .optional()
        .describe("Markup layer: transparent PNG with annotations drawn where the change should happen (URL or local path). Not combinable with mask. Edit models only."),
      reference_field: z
        .string()
        .optional()
        .describe('Payload field that receives reference_images (default "image", as Seedream uses). Some models use e.g. "image_urls" or "images".'),
      extra_params: z.record(z.string(), z.any()).optional().describe("Additional model-specific payload fields, merged as-is."),
      ...commonRunOptions,
    },
    annotations: { openWorldHint: true },
  },
  async (a) => {
    try {
      let model = a.model ?? cfg.defaultModel;
      const hasImageInput = Boolean(a.reference_images?.length || a.mask || a.markup);
      let routedFrom: string | undefined;
      // gpt-image *-generate models take no input image; route to the *-edit sibling.
      if (hasImageInput && /^gpt-image-.*-generate$/.test(model)) {
        routedFrom = model;
        model = model.replace(/-generate$/, "-edit");
      }
      const payload: Record<string, unknown> = { ...(presets[model] ?? {}), ...(a.extra_params ?? {}), prompt: a.prompt };
      const explicit = {
        size: a.size,
        quality: a.quality,
        n: a.n,
        output_format: a.output_format,
        output_compression: a.output_compression,
        background: a.background,
        moderation: a.moderation,
        complexity: a.complexity,
        frame_count: a.frame_count,
        frame_duration_ms: a.frame_duration_ms,
        safety_identifier: a.safety_identifier,
      };
      for (const [k, v] of Object.entries(explicit)) if (v !== undefined) payload[k] = v;
      if (a.reference_images?.length) {
        payload[a.reference_field ?? "image"] = await resolveReferences(gmi(), a.reference_images);
      }
      if (a.mask) payload.mask = (await resolveReferences(gmi(), [a.mask]))[0];
      if (a.markup) payload.markup = (await resolveReferences(gmi(), [a.markup]))[0];
      if (routedFrom) log(`routed ${routedFrom} -> ${model} (image input given)`);
      return await runAndCollect(model, payload, {
        wait: a.wait ?? true,
        timeoutSeconds: a.timeout_seconds,
        outputDir: a.output_dir,
        inline: a.return_image ?? true,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "submit_request",
  {
    title: "Submit raw GMI request",
    description:
      "Low-level: send any payload to any GMI request-queue model (image, video, audio). Use when generate_image's fields don't fit the model's schema.",
    inputSchema: {
      model: z.string().describe("GMI model id."),
      payload: z.record(z.string(), z.any()).describe("The model's payload object, exactly as in GMI docs."),
      ...commonRunOptions,
    },
    annotations: { openWorldHint: true },
  },
  async (a) => {
    try {
      return await runAndCollect(a.model, a.payload, {
        wait: a.wait ?? true,
        timeoutSeconds: a.timeout_seconds,
        outputDir: a.output_dir,
        inline: a.return_image ?? true,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_request",
  {
    title: "Get request status / result",
    description: "Check a GMI request by request_id. When it has succeeded, downloads the outputs (unless download=false).",
    inputSchema: {
      request_id: z.string(),
      download: z.boolean().optional().describe("Download outputs when status is success (default true)."),
      output_dir: z.string().optional(),
      return_image: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (a) => {
    try {
      const req = await gmi().getRequest(a.request_id);
      const saved =
        req.status === "success" && (a.download ?? true)
          ? await downloadOutcome(req, a.output_dir ?? cfg.outputDir, cfg.maxInlineBytes)
          : [];
      if (!saved.length) return { content: [{ type: "text", text: JSON.stringify(req, null, 2) }] };
      return resultContent(req, saved, a.return_image ?? true);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_models",
  {
    title: "List GMI models",
    description: "List model ids available to this GMI API key.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring filter, e.g. \"image\" or \"seedream\"."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (a) => {
    try {
      let ids = await gmi().listModels();
      if (a.filter) ids = ids.filter((m) => m.toLowerCase().includes(a.filter!.toLowerCase()));
      return { content: [{ type: "text", text: JSON.stringify({ count: ids.length, model_ids: ids }, null, 2) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_model",
  {
    title: "Get GMI model info",
    description: "Fetch a model's info (parameters, pricing, etc.) from GMI.",
    inputSchema: { model: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (a) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await gmi().getModel(a.model), null, 2) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_presets",
  {
    title: "List model presets",
    description: "Show the default model and the per-model default payload params loaded from models.json.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      { type: "text", text: JSON.stringify({ default_model: cfg.defaultModel, models_file: cfg.modelsFile, presets }, null, 2) },
    ],
  }),
);

server.registerTool(
  "upload_file",
  {
    title: "Upload local file to GMI",
    description: "Upload a local jpg/png/mp4/mp3/wav and get a public URL usable in GMI payloads.",
    inputSchema: { path: z.string().describe("Local file path (~ allowed).") },
    annotations: { openWorldHint: true },
  },
  async (a) => {
    try {
      const url = await gmi().uploadFile(path.resolve(expandHome(a.path)));
      return { content: [{ type: "text", text: JSON.stringify({ public_url: url }, null, 2) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  if (!cfg.apiKey) log("warning: GMI_API_KEY is not set; tool calls will fail until it is configured.");
  await server.connect(new StdioServerTransport());
  log(`ready (base=${cfg.baseUrl}, default model=${cfg.defaultModel}, presets=${Object.keys(presets).length}, output=${cfg.outputDir})`);
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
