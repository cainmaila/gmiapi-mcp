import { readFile } from "node:fs/promises";
import path from "node:path";

/** Status values documented by GMI Cloud's request queue. */
export type RequestStatus =
  | "queued"
  | "processing"
  | "success"
  | "failed"
  | "cancelled"
  | (string & {});

export const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled"]);

export interface MediaUrl {
  id?: string;
  url: string;
}

export interface GmiRequest {
  request_id: string;
  model?: string;
  status: RequestStatus;
  created_at?: number;
  updated_at?: number;
  queued_at?: number;
  outcome?: {
    media_urls?: MediaUrl[];
    thumbnail_image_url?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export class GmiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GmiError";
  }
}

export interface GmiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-HTTP-call timeout. */
  httpTimeoutMs?: number;
}

const QUEUE = "/api/v1/ie/requestqueue/apikey";

const UPLOAD_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export class GmiClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly httpTimeoutMs: number;

  constructor(opts: GmiClientOptions) {
    if (!opts.apiKey) throw new GmiError("GMI_API_KEY is not set");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://console.gmicloud.ai").replace(/\/+$/, "");
    this.httpTimeoutMs = opts.httpTimeoutMs ?? 120_000;
  }

  private async call<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + apiPath;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
    } catch (err) {
      throw new GmiError(`Network error calling ${method} ${url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new GmiError(
        `GMI API ${method} ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 1000)}`,
        res.status,
        text,
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GmiError(`GMI API ${method} ${apiPath} returned non-JSON: ${text.slice(0, 300)}`, res.status, text);
    }
  }

  /** List model IDs available to this API key. */
  async listModels(): Promise<string[]> {
    // The docs show both paths; try the request-queue one first.
    for (const p of [`${QUEUE}/models`, "/api/v1/apikey/models"]) {
      try {
        const r = await this.call<{ model_ids?: string[]; models?: unknown[] }>("GET", p);
        if (Array.isArray(r.model_ids)) return r.model_ids;
        if (Array.isArray(r.models)) {
          return r.models.map((m) => (typeof m === "string" ? m : String((m as any)?.id ?? (m as any)?.model_id ?? JSON.stringify(m))));
        }
        return [];
      } catch (err) {
        if (err instanceof GmiError && err.httpStatus === 404) continue;
        throw err;
      }
    }
    return [];
  }

  getModel(modelId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `${QUEUE}/models/${encodeURIComponent(modelId)}`);
  }

  submit(model: string, payload: Record<string, unknown>): Promise<GmiRequest> {
    return this.call("POST", `${QUEUE}/requests`, { model, payload });
  }

  getRequest(requestId: string): Promise<GmiRequest> {
    return this.call("GET", `${QUEUE}/requests/${encodeURIComponent(requestId)}`);
  }

  listRequests(modelId?: string): Promise<unknown> {
    const q = modelId ? `?model_id=${encodeURIComponent(modelId)}` : "";
    return this.call("GET", `${QUEUE}/requests${q}`);
  }

  /** Poll until the request reaches a terminal status or the deadline passes. */
  async waitFor(
    requestId: string,
    opts: { timeoutMs: number; intervalMs: number; onPoll?: (r: GmiRequest) => void },
  ): Promise<GmiRequest> {
    const deadline = Date.now() + opts.timeoutMs;
    let interval = opts.intervalMs;
    for (;;) {
      const r = await this.getRequest(requestId);
      opts.onPoll?.(r);
      if (TERMINAL_STATUSES.has(r.status)) return r;
      if (Date.now() + interval > deadline) {
        throw new GmiError(
          `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for request ${requestId} (last status: ${r.status}). ` +
            `Call get_request later with this request_id.`,
        );
      }
      await new Promise((res) => setTimeout(res, interval));
      interval = Math.min(interval * 1.5, 10_000);
    }
  }

  /** Upload a local file via GMI's two-step upload; returns a stable public URL. */
  async uploadFile(filePath: string): Promise<string> {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = UPLOAD_MIME[ext];
    if (!mime) {
      throw new GmiError(`Unsupported upload type ".${ext}". Allowed: ${Object.keys(UPLOAD_MIME).join(", ")}`);
    }
    const data = await readFile(filePath);
    const { upload_url, public_url } = await this.call<{ upload_url: string; public_url: string }>(
      "POST",
      `${QUEUE}/upload-url`,
      { file_type: ext },
    );
    if (!upload_url || !public_url) throw new GmiError("upload-url response missing upload_url/public_url");
    const put = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: data,
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!put.ok) {
      throw new GmiError(`Upload PUT failed: HTTP ${put.status} ${(await put.text()).slice(0, 300)}`, put.status);
    }
    return public_url;
  }
}
