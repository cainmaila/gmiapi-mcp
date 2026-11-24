// End-to-end test: real MCP client <-> our server <-> mock GMI API (no API key or network needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const Q = "/api/v1/ie/requestqueue/apikey";
let mock, base, client, outDir;
const submitted = [];
const polls = {};

before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), "gmi-mcp-test-"));
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const u = new URL(req.url, base);
    if (u.pathname.startsWith("/api/") && req.headers.authorization !== "Bearer test-key") return json(401, { error: "bad key" });

    if (req.method === "GET" && u.pathname === `${Q}/models`) return json(200, { model_ids: ["seedream-4-0-250828", "gpt-image-2", "kling-video"] });
    if (req.method === "POST" && u.pathname === `${Q}/requests`) {
      const b = JSON.parse(body);
      submitted.push(b);
      const id = `req-${submitted.length}`;
      if (b.payload.prompt === "boom") return json(200, { request_id: id, model: b.model, status: "failed", error: "nsfw" });
      return json(200, { request_id: id, model: b.model, status: "queued" });
    }
    const m = u.pathname.match(new RegExp(`^${Q}/requests/(.+)$`));
    if (req.method === "GET" && m) {
      const id = m[1];
      polls[id] = (polls[id] ?? 0) + 1;
      if (polls[id] < 2) return json(200, { request_id: id, status: "processing" });
      return json(200, { request_id: id, status: "success", outcome: { media_urls: [{ id: "0", url: `${base}/out/a.png` }] } });
    }
    if (req.method === "POST" && u.pathname === `${Q}/upload-url`) {
      return json(200, { upload_url: `${base}/put/ref`, public_url: `${base}/pub/ref.${JSON.parse(body).file_type}` });
    }
    if (req.method === "PUT" && u.pathname === "/put/ref") { res.writeHead(200); return res.end(); }
    if (req.method === "GET" && u.pathname === "/out/a.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    json(404, { error: "not found" });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;

  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, GMI_API_KEY: "test-key", GMI_BASE_URL: base, GMI_OUTPUT_DIR: outDir, GMI_POLL_INTERVAL_MS: "50" },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client?.close();
  mock?.close();
});

const text = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

test("lists tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["generate_image", "get_model", "get_request", "list_models", "list_presets", "submit_request", "upload_file"]);
});

test("list_models with filter", async () => {
  const r = text(await client.callTool({ name: "list_models", arguments: { filter: "image" } }));
  assert.deepEqual(r.model_ids, ["gpt-image-2"]);
});

test("generate_image: submit, poll, download, inline image, local ref upload", async () => {
  const ref = path.join(outDir, "ref.png");
  await writeFile(ref, PNG);
  const r = await client.callTool({
    name: "generate_image",
    arguments: { model: "seedream-4-0-250828", prompt: "a fox", size: "1024x1024", reference_images: [ref, "https://x/y.jpg"], extra_params: { seed: 42 } },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const s = text(r);
  assert.equal(s.status, "success");
  assert.equal(s.files.length, 1);
  assert.deepEqual(await readFile(s.files[0].path), PNG);
  assert.ok(r.content.some((c) => c.type === "image" && c.mimeType === "image/png"));
  const sent = submitted.at(-1);
  assert.equal(sent.model, "seedream-4-0-250828");
  assert.deepEqual(sent.payload, { watermark: false, seed: 42, prompt: "a fox", size: "1024x1024", image: [`${base}/pub/ref.png`, "https://x/y.jpg"] });
});

test("wait=false returns request_id, get_request fetches result", async () => {
  const r = text(await client.callTool({ name: "submit_request", arguments: { model: "kling-video", payload: { prompt: "x" }, wait: false } }));
  assert.equal(r.status, "queued");
  const g1 = text(await client.callTool({ name: "get_request", arguments: { request_id: r.request_id } }));
  assert.equal(g1.status, "processing");
  const g2 = await client.callTool({ name: "get_request", arguments: { request_id: r.request_id, return_image: false } });
  assert.equal(text(g2).files.length, 1);
  assert.ok(!g2.content.some((c) => c.type === "image"));
});

test("failed request surfaces as tool error", async () => {
  const r = await client.callTool({ name: "generate_image", arguments: { prompt: "boom" } });
  assert.equal(r.isError, true);
  assert.equal(text(r).status, "failed");
});

test("gpt-image-2.6 preset + explicit params override, extra_params passthrough", async () => {
  const r = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "a cat", quality: "low", complexity: "high", output_format: "jpeg", output_compression: 80, extra_params: { user: "u1", n: 3 } },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const sent = submitted.at(-1);
  assert.equal(sent.model, "gpt-image-2.6-sunburst-generate");
  assert.deepEqual(sent.payload, {
    size: "1024x1024", quality: "low", complexity: "high", n: 3, output_format: "jpeg", background: "auto", moderation: "auto",
    user: "u1", prompt: "a cat", output_compression: 80,
  });
});

test("list_presets", async () => {
  const r = text(await client.callTool({ name: "list_presets", arguments: {} }));
  assert.equal(r.default_model, "gpt-image-2.6-sunburst-generate");
  assert.equal(r.presets["gpt-image-2.6-sunburst-generate"].quality, "medium");
});

test("image input on a gpt-image *-generate model routes to *-edit, with mask + webp data URI", async () => {
  const ref = path.join(outDir, "src.png");
  const mask = path.join(outDir, "mask.png");
  const webp = path.join(outDir, "extra.webp");
  await writeFile(ref, PNG);
  await writeFile(mask, PNG);
  await writeFile(webp, Buffer.from("RIFFxxxxWEBP"));
  const r = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "add a scarf", reference_images: [ref, webp], mask },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const sent = submitted.at(-1);
  assert.equal(sent.model, "gpt-image-2.6-sunburst-edit");
  assert.equal(sent.payload.quality, "medium");
  assert.equal(sent.payload.image[0], `${base}/pub/ref.png`);
  assert.match(sent.payload.image[1], /^data:image\/webp;base64,/);
  assert.equal(sent.payload.mask, `${base}/pub/ref.png`);
});
