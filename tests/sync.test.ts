import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatListened, plural } from "../src/lib/sync/format";
import { DEFAULT_SETTINGS, normalizeSettings, settingsEqual } from "../src/lib/storage/prefs";

describe("the home counter", () => {
  it("reads in minutes until there is an hour to show", () => {
    assert.deepEqual(formatListened(0), { figure: "0", unit: "minutes" });
    assert.deepEqual(formatListened(90), { figure: "1", unit: "minute" });
    assert.deepEqual(formatListened(45 * 60), { figure: "45", unit: "minutes" });
  });

  it("shows a decimal while the hours are few, then whole hours", () => {
    assert.deepEqual(formatListened(3600), { figure: "1.0", unit: "hours" });
    assert.deepEqual(formatListened(12.46 * 3600), { figure: "12.4", unit: "hours" });
    assert.deepEqual(formatListened(412806 * 3600 + 1200), { figure: "412,806", unit: "hours" });
  });

  it("pluralises readers", () => {
    assert.equal(plural(1, "reader", "readers"), "1 reader");
    assert.equal(plural(9140, "reader", "readers"), "9,140 readers");
  });
});

describe("settings from another device", () => {
  it("fills gaps and rejects nonsense", () => {
    const settings = normalizeSettings({ theme: "warm", accent: "moss", fontSize: 99, rate: 7 } as never);
    assert.equal(settings.theme, "warm");
    assert.equal(settings.accent, "moss");
    assert.equal(settings.fontSize, 26);
    assert.equal(settings.rate, 2.5);
    assert.equal(settings.highlight, "pill");
    assert.equal(settings.updatedAt, 0);
  });

  it("falls back to slate for an unknown accent", () => {
    assert.equal(normalizeSettings({ accent: "neon" } as never).accent, "slate");
  });

  it("compares what the reader chose, not the bookkeeping", () => {
    const a = { ...DEFAULT_SETTINGS, updatedAt: 1 };
    const b = { ...DEFAULT_SETTINGS, updatedAt: 2 };
    assert.ok(settingsEqual(a, b));
    assert.ok(!settingsEqual(a, { ...b, accent: "violet" }));
  });
});
