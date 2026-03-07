import { z } from "zod";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { truncateText } from "../utils/paths";
import { resolveSafeWebUrl } from "../utils/webSafety";

const MAX_REDIRECTS = 5;
let responseTimeoutMs = 5_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  const [rawMimeType] = contentType.split(";", 1);
  const normalized = rawMimeType?.trim().toLowerCase();
  return normalized || null;
}

function supportedImageMimeTypeFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  return null;
}

function classifyResponseContent(
  contentType: string | null,
  resolvedUrl: string
): { kind: "text" } | { kind: "image"; mimeType: string } {
  const normalized = normalizeMimeType(contentType);
  if (normalized && SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
    return {
      kind: "image",
      mimeType: normalized === "image/jpg" ? "image/jpeg" : normalized,
    };
  }

  const inferredImageMimeType = supportedImageMimeTypeFromUrl(resolvedUrl);
  if ((!normalized || normalized === "application/octet-stream") && inferredImageMimeType) {
    return { kind: "image", mimeType: inferredImageMimeType };
  }

  if (!normalized) return { kind: "text" };
  if (normalized.startsWith("text/")) return { kind: "text" };
  if (normalized.includes("json")) return { kind: "text" };
  if (normalized.includes("xml")) return { kind: "text" };
  if (normalized.includes("javascript")) return { kind: "text" };
  throw new Error(`Blocked non-text content type: ${contentType}`);
}

function buildPinnedUrl(resolved: { url: URL; addresses: { address: string; family: number }[] }): {
  pinnedUrl: URL;
  hostHeader: string;
} {
  const addr = resolved.addresses[0];
  if (!addr) throw new Error(`Blocked unresolved host: ${resolved.url.hostname}`);

  const pinnedUrl = new URL(resolved.url.toString());
  const hostHeader = pinnedUrl.host;
  pinnedUrl.hostname = addr.family === 6 ? `[${addr.address}]` : addr.address;
  return { pinnedUrl, hostHeader };
}

async function fetchWithSafeRedirects(url: string, abortSignal?: AbortSignal): Promise<Response> {
  let current = await resolveSafeWebUrl(url);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const { pinnedUrl, hostHeader } = buildPinnedUrl(current);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, responseTimeoutMs);
    const onAbort = () => {
      timeoutController.abort();
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let res: Response;
    try {
      res = await fetch(pinnedUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": "agent-coworker/0.1",
          Host: hostHeader,
        },
        signal: timeoutController.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`webFetch timed out waiting for an initial response after ${responseTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
    }

    if (!isRedirectStatus(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location header: ${current.url.toString()}`);
    }

    const next = new URL(location, current.url).toString();
    current = await resolveSafeWebUrl(next);
  }

  throw new Error(`Too many redirects while fetching URL: ${url}`);
}

export const __internal = {
  getResponseTimeoutMs: () => responseTimeoutMs,
  setResponseTimeoutMs: (ms: number) => {
    responseTimeoutMs = ms;
  },
};

export function createWebFetchTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Fetch a URL and return clean markdown for web pages, or visual content for supported direct image URLs.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      maxLength: z.number().int().min(1000).max(200000).optional().default(50000),
    }),
    execute: async ({ url, maxLength }: { url: string; maxLength: number }) => {
      ctx.log(`tool> webFetch ${JSON.stringify({ url, maxLength })}`);

      const res = await fetchWithSafeRedirects(url, ctx.abortSignal);
      if (!res.ok) {
        throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
      }
      const finalUrl = (await resolveSafeWebUrl(res.url || url)).url.toString();
      const contentKind = classifyResponseContent(res.headers.get("content-type"), finalUrl);
      if (contentKind.kind === "image") {
        const bytes = Buffer.from(await res.arrayBuffer());
        const result = {
          type: "content",
          content: [
            { type: "text", text: `Image URL: ${finalUrl}` },
            { type: "image", data: bytes.toString("base64"), mimeType: contentKind.mimeType },
          ],
        };
        ctx.log(
          `tool< webFetch ${JSON.stringify({
            image: true,
            mimeType: contentKind.mimeType,
            bytes: bytes.length,
          })}`
        );
        return result;
      }

      const html = await res.text();
      const dom = new JSDOM(html, { url: finalUrl });
      const article = new Readability(dom.window.document).parse();

      const turndown = new TurndownService();
      const md = article?.content
        ? turndown.turndown(article.content)
        : turndown.turndown(html);

      const out = truncateText(md, maxLength);
      ctx.log(`tool< webFetch ${JSON.stringify({ chars: out.length })}`);
      return out;
    },
  });
}
