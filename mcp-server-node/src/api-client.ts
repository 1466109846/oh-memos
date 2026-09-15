/**
 * MemOS MCP Server API Client Module
 *
 * HTTP fetch wrapper with timeout, retry, and health check.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";

import {
  MEMOS_URL,
  MEMOS_API_WAIT_MAX,
  MEMOS_TIMEOUT_HEALTH,
  MEMOS_TIMEOUT_TOOL,
  logger,
  registeredCubes,
} from "./config.js";

// ============================================================================
// Fetch with Timeout
// ============================================================================

const API_NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
] as const;

// These failures happen before an HTTP request can be delivered. They are the
// only network errors safe to replay for a non-idempotent method.
const API_ALIAS_SAFE_ERROR_CODES = [
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
] as const;

let discoveredWslHosts: string[] | undefined;

function isWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  if (process.platform !== "linux") return false;
  const kernel = osRelease().toLowerCase();
  return kernel.includes("microsoft") || kernel.includes("wsl");
}

function normalizeDiscoveredHost(value: string): string | undefined {
  const host = value.trim().replace(/^\[|\]$/g, "").replace(/%[^/]+$/, "");
  if (
    !host ||
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(?:\.[0-9]+){3}$/.test(host)
  ) {
    return undefined;
  }
  return host.includes(":") ? `[${host}]` : host;
}

function discoverWslHosts(): string[] {
  if (discoveredWslHosts) return discoveredWslHosts;

  const hosts = new Set<string>(["host.docker.internal"]);
  try {
    const resolvConf = readFileSync("/etc/resolv.conf", "utf8");
    for (const line of resolvConf.split(/\r?\n/)) {
      const match = /^\s*nameserver\s+(\S+)/.exec(line);
      const host = match ? normalizeDiscoveredHost(match[1]) : undefined;
      if (host) hosts.add(host);
    }
  } catch {
    // WSL integrations may not expose resolv.conf; keep the other candidates.
  }

  try {
    const routeOutput = String(
      execFileSync("ip", ["route", "show", "default"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const match = /(?:^|\s)default\s+via\s+(\S+)/.exec(routeOutput);
    const host = match ? normalizeDiscoveredHost(match[1]) : undefined;
    if (host) hosts.add(host);
  } catch {
    // The ip utility is optional; resolv.conf and host.docker.internal suffice.
  }

  discoveredWslHosts = [...hosts];
  return discoveredWslHosts;
}

function replaceUrlHost(url: string, host: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** A response deadline does not prove the API is offline or a write failed. */
export function isApiTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (details.name === "AbortError" || details.name === "TimeoutError") return true;
  if (details.code === "UND_ERR_HEADERS_TIMEOUT" || details.code === "UND_ERR_BODY_TIMEOUT") return true;
  return details.cause !== undefined && details.cause !== error && isApiTimeoutError(details.cause);
}

/** Return true when an exception means the HTTP peer could not be reached. */
export function isApiUnreachableError(error: unknown): boolean {
  if (isApiTimeoutError(error)) return false;
  if (typeof error === "object" && error !== null) {
    const details = error as { code?: unknown; name?: unknown; cause?: unknown };
    if (
      typeof details.code === "string" &&
      API_NETWORK_ERROR_CODES.includes(details.code as (typeof API_NETWORK_ERROR_CODES)[number])
    ) {
      return true;
    }
    if (details.cause !== undefined && isApiUnreachableError(details.cause)) {
      return true;
    }
  }

  const message = String(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("connect timeout") ||
    API_NETWORK_ERROR_CODES.some((code) => message.includes(code.toLowerCase()))
  );
}

/** Return true only when no request body could have reached the peer. */
export function isSafeApiAliasFallbackError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const details = error as { code?: unknown; cause?: unknown };
    if (
      typeof details.code === "string" &&
      API_ALIAS_SAFE_ERROR_CODES.includes(
        details.code as (typeof API_ALIAS_SAFE_ERROR_CODES)[number],
      )
    ) {
      return true;
    }
    if (details.cause !== undefined && isSafeApiAliasFallbackError(details.cause)) {
      return true;
    }
  }

  const message = String(error).toLowerCase();
  return API_ALIAS_SAFE_ERROR_CODES.some((code) => message.includes(code.toLowerCase()));
}

/** Add the IPv4 loopback alias for clients whose resolver prefers IPv6. */
export function apiUrlCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [url];

  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") return [url];

  const alias = new URL(url);
  alias.hostname = host === "localhost" ? "127.0.0.1" : "localhost";
  const candidates = [url, alias.toString()];

  if (isWslRuntime()) {
    for (const discoveredHost of discoverWslHosts()) {
      const candidate = replaceUrlHost(url, discoveredHost);
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

const preferredLoopbackHosts = new Map<string, string>();

function orderedApiUrlCandidates(url: string): string[] {
  const candidates = apiUrlCandidates(url);
  if (candidates.length < 2) return candidates;

  try {
    const parsed = new URL(url);
    const preferredHost = preferredLoopbackHosts.get(parsed.origin);
    if (!preferredHost) return candidates;

    const preferred = new URL(url);
    preferred.hostname = preferredHost;
    const preferredUrl = preferred.toString();
    return [preferredUrl, ...candidates.filter((candidate) => candidate !== preferredUrl)];
  } catch {
    return candidates;
  }
}

/** Join an API path to the configured base without losing its prefix/query. */
export function apiUrl(path = "", base = MEMOS_URL): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  try {
    const parsedBase = new URL(base);
    const parsedPath = new URL(normalizedPath, "http://memos.local");
    const basePath = parsedBase.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
    const childPath = parsedPath.pathname.replace(/^\/+/, "");
    const joinedPath = [basePath, childPath].filter(Boolean).join("/");
    parsedBase.pathname = joinedPath ? `/${joinedPath}` : "/";

    // Base query values (for example a gateway token) apply to every endpoint;
    // a path-specific value wins when both use the same key.
    const query = new URLSearchParams(parsedBase.search);
    for (const [key, value] of parsedPath.searchParams) query.set(key, value);
    parsedBase.search = query.toString();
    parsedBase.hash = "";
    return parsedBase.toString();
  } catch {
    // Keep the old string behavior for a malformed base; the first fetch then
    // reports the useful URL error to the caller.
    const cleanBase = base.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const cleanPath = normalizedPath.replace(/^\/+/, "");
    return `${cleanBase}/${cleanPath}`;
  }
}

export function apiHealthUrl(base = MEMOS_URL, detail = false): string {
  const suffix = detail ? "/health/detail" : "/health";
  return apiUrl(suffix, base);
}

/** Remove credentials and query values before an endpoint is shown to a client. */
export function apiUrlForDisplay(url = MEMOS_URL): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const displayed = parsed.toString();
    return parsed.pathname === "/" && displayed.endsWith("/")
      ? displayed.slice(0, -1)
      : displayed;
  } catch {
    return url
      .replace(/[?#].*$/, "")
      .replace(/:\/\/[^/@\s]+@/, "://");
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = (options.timeoutMs ?? MEMOS_TIMEOUT_TOOL) * 1000;
  const { timeoutMs: _, ...fetchOptions } = options;
  const method = String(fetchOptions.method ?? "GET").toUpperCase();
  const candidates = orderedApiUrlCandidates(url);
  const isIdempotent = method === "GET" || method === "HEAD";
  let originalOrigin: string | undefined;
  try {
    originalOrigin = new URL(url).origin;
  } catch {
    // The first fetch will report the malformed URL.
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(candidate, {
        ...fetchOptions,
        signal: controller.signal,
      });
      if (originalOrigin) {
        const selectedOrigin = new URL(candidate).origin;
        if (selectedOrigin === originalOrigin) {
          preferredLoopbackHosts.delete(originalOrigin);
        } else {
          preferredLoopbackHosts.set(originalOrigin, new URL(candidate).hostname);
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      const canTryAlias = candidate !== candidates.at(-1) &&
        (isIdempotent
          ? isApiUnreachableError(error)
          : isSafeApiAliasFallbackError(error));
      if (!canTryAlias) {
        if (originalOrigin) {
          preferredLoopbackHosts.delete(originalOrigin);
        }
        throw error;
      }
      logger.debug("MemOS API endpoint failed, trying loopback alias");
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// ============================================================================
// API Readiness Check
// ============================================================================

export async function waitForApiReady(
  maxWait?: number,
  interval = 2.0,
): Promise<boolean> {
  const maxWaitMs = (maxWait ?? MEMOS_API_WAIT_MAX) * 1000;
  const intervalMs = interval * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetchWithTimeout(apiUrl("/users"), {
        timeoutMs: MEMOS_TIMEOUT_HEALTH,
      });
      if (response.ok) {
        logger.debug("MemOS API is ready");
        return true;
      }
    } catch {
      // Not ready yet
    }
    await sleep(intervalMs);
  }

  logger.warning(`MemOS API not ready after ${maxWait ?? MEMOS_API_WAIT_MAX}s`);
  return false;
}

// ============================================================================
// API Call with Retry
// ============================================================================

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface ApiCallOptions {
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export interface ApiCallResult {
  success: boolean;
  data: Record<string, unknown> | null;
  status: number;
}

function buildUrl(
  base: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return base;
  const urlParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) urlParams.append(k, String(v));
  }
  const qs = urlParams.toString();
  if (!qs) return base;
  const hashIndex = base.indexOf("#");
  const beforeHash = hashIndex === -1 ? base : base.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : base.slice(hashIndex);
  const separator = beforeHash.includes("?")
    ? (beforeHash.endsWith("?") || beforeHash.endsWith("&") ? "" : "&")
    : "?";
  return `${beforeHash}${separator}${qs}${hash}`;
}

async function doFetch(
  method: HttpMethod,
  url: string,
  options: ApiCallOptions,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const finalUrl = buildUrl(url, options.params);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (options.body !== undefined && method !== "GET") {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetchWithTimeout(
    finalUrl,
    fetchOptions as RequestInit & { timeoutMs?: number },
  );

  if (!response.ok && response.status !== 400) {
    return { status: response.status, data: null };
  }

  try {
    const data = (await response.json()) as Record<string, unknown>;
    return { status: response.status, data };
  } catch (error) {
    // Body reads can fail after response headers arrive. Preserve deadlines
    // as exceptions so an ambiguous POST is not replayed or reported offline.
    if (isApiTimeoutError(error)) throw error;
    return { status: response.status, data: null };
  }
}

export async function apiCallWithRetry(
  method: HttpMethod,
  url: string,
  cubeId: string,
  options: ApiCallOptions = {},
  ensureCubeRegistered?: (
    cubeId: string,
    force?: boolean,
  ) => Promise<[boolean, string | null]>,
): Promise<ApiCallResult> {
  const { status, data } = await doFetch(method, url, options);

  if (status === 200 && data) {
    if ((data as Record<string, unknown>).code === 200) {
      return { success: true, data, status: 200 };
    }

    // API returned error code - try re-registration if available
    if (ensureCubeRegistered) {
      registeredCubes.delete(cubeId);
      const [regSuccess] = await ensureCubeRegistered(cubeId, true);
      if (regSuccess) {
        const retry = await doFetch(method, url, options);
        if (
          retry.status === 200 &&
          retry.data &&
          (retry.data as Record<string, unknown>).code === 200
        ) {
          return { success: true, data: retry.data, status: 200 };
        }
        return { success: false, data: retry.data, status: 200 };
      }
    }

    return { success: false, data, status: 200 };
  }

  if (status === 400 && ensureCubeRegistered) {
    // 400 often means cube not loaded
    registeredCubes.delete(cubeId);
    const [regSuccess] = await ensureCubeRegistered(cubeId, true);
    if (regSuccess) {
      const retry = await doFetch(method, url, options);
      if (
        retry.status === 200 &&
        retry.data &&
        (retry.data as Record<string, unknown>).code === 200
      ) {
        return { success: true, data: retry.data, status: 200 };
      }
      // 重注册没救回来 —— 说明这不是「cube 未加载」，而是真实的业务错误。
      // 必须把正文带回去：后端把 not-found 也映射成 400（start_api.py 的
      // ValueError handler），唯一能区分的信息就在 message 里。丢掉它会让
      // 调用方只能打印无用的 "HTTP 400"。重试正文优先，缺失则退回首次的。
      return { success: false, data: retry.data ?? data, status: 400 };
    }
    return { success: false, data, status: 400 };
  }

  return { success: false, data, status };
}

// ============================================================================
// Helper
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
