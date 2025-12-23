import { env } from "cloudflare:test";
import { describe, test, expect, beforeEach } from "vitest";

describe("Logs FTS", () => {
  // Helper to generate timestamp
  const genTimestamp = (daysAgo: number = 0) => {
    return String(BigInt(Date.now() - daysAgo * 24 * 60 * 60 * 1000) * 1_000_000n);
  };

  test("write and read basic logs", async () => {
    const stub = env.LOGS.getByName("test-basic");
    const logs = [
      { ts: genTimestamp(0), log: "Server started on port 8080" },
      { ts: genTimestamp(0), log: "Database connection established" },
      { ts: genTimestamp(0), log: "User authentication successful" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({});
    expect(result.length).toBe(3);
    expect(result[0].log).toBeDefined();
    expect(result[0].ts_sec).toBeDefined();
  });

  test("FTS search with single term", async () => {
    const stub = env.LOGS.getByName("test-search-single");
    const logs = [
      { ts: genTimestamp(0), log: "Error: connection timeout" },
      { ts: genTimestamp(0), log: "Warning: high memory usage" },
      { ts: genTimestamp(0), log: "Error: database query failed" },
      { ts: genTimestamp(0), log: "Info: request completed" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({ search: "error" });
    expect(result.length).toBe(2);
    expect(result[0].highlighted_log).toContain("<mark>");
    expect(result[0].highlighted_log).toContain("</mark>");
  });

  test("FTS search with substring (trigram)", async () => {
    const stub = env.LOGS.getByName("test-search-substring");
    const logs = [
      { ts: genTimestamp(0), log: "Error: connection timeout" },
      { ts: genTimestamp(0), log: "terror in the night" },
      { ts: genTimestamp(0), log: "Everything is fine" },
    ];
    await stub.writeLogs(logs);

    // Should match both "Error" and "terror" with substring "rror"
    const result = await stub.getLogs({ search: "rror" });
    expect(result.length).toBe(2);
    expect(result.some((log: any) => log.log.includes("Error"))).toBe(true);
    expect(result.some((log: any) => log.log.includes("terror"))).toBe(true);
  });

  test("FTS search with multiple terms", async () => {
    const stub = env.LOGS.getByName("test-search-multi");
    const logs = [
      { ts: genTimestamp(0), log: "Database connection timeout" },
      { ts: genTimestamp(0), log: "Connection established successfully" },
      { ts: genTimestamp(0), log: "Network timeout error" },
      { ts: genTimestamp(0), log: "Request processing started" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({ search: "connection timeout" });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].highlighted_log).toBeDefined();
  });

  test("7-day time window filter", async () => {
    const stub = env.LOGS.getByName("test-timewindow");
    const logs = [
      { ts: genTimestamp(3), log: "Recent log 3 days ago" },
      { ts: genTimestamp(6), log: "Older log 6 days ago" },
      { ts: genTimestamp(8), log: "Ancient log 8 days ago" },
      { ts: genTimestamp(10), log: "Very old log 10 days ago" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({});
    // Should only return logs within 7 days
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.some((log: any) => log.log.includes("Ancient"))).toBe(false);
  });

  test("search with time window", async () => {
    const stub = env.LOGS.getByName("test-search-time");
    const logs = [
      { ts: genTimestamp(2), log: "Error: timeout occurred" },
      { ts: genTimestamp(5), log: "Error: another timeout" },
      { ts: genTimestamp(9), log: "Error: old timeout message" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({ search: "timeout" });
    // Should only return errors within 7 days
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.every((log: any) => log.highlighted_log.includes("<mark>"))).toBe(true);
  });

  test("no results returns empty array", async () => {
    const stub = env.LOGS.getByName("test-no-results");
    const logs = [
      { ts: genTimestamp(0), log: "Server started" },
      { ts: genTimestamp(0), log: "Database connected" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({ search: "nonexistent" });
    expect(result.length).toBe(0);
  });

  test("highlighted_log present in all results", async () => {
    const stub = env.LOGS.getByName("test-highlight");
    const logs = [
      { ts: genTimestamp(0), log: "Simple log message" },
      { ts: genTimestamp(0), log: "Another log entry" },
    ];
    await stub.writeLogs(logs);

    const result = await stub.getLogs({});
    expect(result.every((log: any) => log.highlighted_log !== undefined)).toBe(true);
    
    const searchResult = await stub.getLogs({ search: "log" });
    expect(searchResult.every((log: any) => log.highlighted_log.includes("<mark>"))).toBe(true);
  });

  test("limit parameter works correctly", async () => {
    const stub = env.LOGS.getByName("test-limit");
    const logs = new Array(50).fill(null).map((_, i) => ({
      ts: genTimestamp(0),
      log: `Log entry number ${i}`,
    }));
    await stub.writeLogs(logs);

    const result = await stub.getLogs({ limit: 10 });
    expect(result.length).toBe(10);
  });
});
