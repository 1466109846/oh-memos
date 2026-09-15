import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiUrlCandidates,
  apiUrl,
  apiHealthUrl,
  apiUrlForDisplay,
  apiCallWithRetry,
  fetchWithTimeout,
  isApiTimeoutError,
  isApiUnreachableError,
} from "./api-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API connectivity helpers", () => {
  it.each([
    ["ECONNREFUSED", new Error("connect ECONNREFUSED 127.0.0.1:18000")],
    ["ECONNABORTED", Object.assign(new Error("software caused connection abort"), { code: "ECONNABORTED" })],
    ["ECONNRESET", new Error("socket ECONNRESET")],
    ["ETIMEDOUT", Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" })],
    ["ENETDOWN", Object.assign(new Error("network is down"), { code: "ENETDOWN" })],
    ["ENETUNREACH", new Error("connect ENETUNREACH")],
    ["EHOSTDOWN", Object.assign(new Error("host is down"), { code: "EHOSTDOWN" })],
    ["EHOSTUNREACH", new Error("connect EHOSTUNREACH")],
    ["fetch failed", new TypeError("fetch failed")],
  ])("recognizes %s as an unreachable API error", (_name, error) => {
    expect(isApiUnreachableError(error)).toBe(true);
  });

  it("does not classify an HTTP response error as a network failure", () => {
    expect(isApiUnreachableError(new Error("HTTP 503 Service Unavailable"))).toBe(false);
  });

  it.each([
    new DOMException("The operation was aborted", "AbortError"),
    new DOMException("The operation timed out", "TimeoutError"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }),
  ])("distinguishes request deadlines from an unreachable API", (error) => {
    expect(isApiTimeoutError(error)).toBe(true);
    expect(isApiUnreachableError(error)).toBe(false);
  });

  it("does not replay a write after its response deadline expires", async () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithTimeout("http://localhost:18009/memories", {
      method: "POST", body: "{}", timeoutMs: 1,
    })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adds the IPv4 alias while preserving the request path and query", () => {
    expect(apiUrlCandidates("http://localhost:18000/health?full=true").slice(0, 2)).toEqual([
      "http://localhost:18000/health?full=true",
      "http://127.0.0.1:18000/health?full=true",
    ]);
    expect(apiUrlCandidates("http://127.0.0.1:18000/health").slice(0, 2)).toEqual([
      "http://127.0.0.1:18000/health",
      "http://localhost:18000/health",
    ]);
  });

  it("discovers a Windows host candidate for direct WSL clients", () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    try {
      expect(apiUrlCandidates("http://localhost:18000/api?token=redacted")).toContain(
        "http://host.docker.internal:18000/api?token=redacted",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls through to a discovered WSL host after both loopback addresses fail", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    try {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithTimeout("http://localhost:18004/health", { timeoutMs: 1 }),
      ).resolves.toMatchObject({ ok: true });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:18004/health",
        "http://127.0.0.1:18004/health",
        "http://host.docker.internal:18004/health",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds health paths before an endpoint query string", () => {
    expect(apiHealthUrl("https://localhost:18443/prefix?token=redacted")).toBe(
      "https://localhost:18443/prefix/health?token=redacted",
    );
  });

  it("redacts credentials and query values from displayed endpoint URLs", () => {
    expect(apiUrlForDisplay("https://user:pass@example.test:18443/api?token=secret#fragment")).toBe(
      "https://example.test:18443/api",
    );
  });

  it("joins API paths before a base query string and merges request parameters", () => {
    expect(apiUrl("/memories?user_id=dev_user", "https://localhost:18443/prefix?token=redacted#ignored")).toBe(
      "https://localhost:18443/prefix/memories?token=redacted&user_id=dev_user",
    );
  });

  it("tries the IPv4 alias when the first loopback endpoint cannot connect", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithTimeout("http://localhost:18000/health", {
      timeoutMs: 1,
    });

    expect(response.ok).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:18000/health",
      "http://127.0.0.1:18000/health",
    ]);

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    await fetchWithTimeout("http://localhost:18000/users", { timeoutMs: 1 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:18000/users",
    ]);
  });

  it.each(["POST", "DELETE"])(
    "does not replay a %s after an ambiguous connection failure",
    async (method) => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithTimeout(`http://localhost:18001/${method.toLowerCase()}`, {
          method,
          timeoutMs: 1,
        }),
      ).rejects.toThrow("fetch failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a cached reachable alias for a later write without replaying it", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithTimeout("http://localhost:18002/health", { timeoutMs: 1 });
    await fetchWithTimeout("http://localhost:18002/mem_cubes", {
      method: "POST",
      body: "{}",
      timeoutMs: 1,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:18002/health",
      "http://127.0.0.1:18002/health",
      "http://127.0.0.1:18002/mem_cubes",
    ]);
  });

  it("allows a write fallback only for a connection refusal", async () => {
    const refused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithTimeout("http://localhost:18003/mem_cubes", {
      method: "POST",
      body: "{}",
      timeoutMs: 1,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:18003/mem_cubes",
      "http://127.0.0.1:18003/mem_cubes",
    ]);
  });

  it("places request parameters before a URL fragment", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, data: {} }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiCallWithRetry(
      "GET",
      "http://example.test/path?token=redacted#ignored",
      "cube",
      { params: { user_id: "dev_user" } },
    );

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://example.test/path?token=redacted&user_id=dev_user#ignored",
    );
  });
});
