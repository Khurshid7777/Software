import { describe, expect, it } from "vitest";
import { MAINTENANCE, USAGE_LEVELS, batteryAt, forecastDevice, type ForecastInput } from "../src/forecast.js";

const phone: ForecastInput = { category: "smartphone", condition: "good", price: 5_700_000, checklist: { batteryPct: 86, ageYears: 2 } };

describe("device forecast", () => {
  it("battery only goes down, and faster with heavier use", () => {
    const byUse = USAGE_LEVELS.map((u) => forecastDevice(phone, u, 5).battery!.series);
    for (const s of byUse) {
      expect(s[0]).toBe(86);
      for (let i = 1; i < s.length; i++) expect(s[i]!).toBeLessThan(s[i - 1]!);
    }
    for (let t = 1; t <= 5; t++) {
      expect(byUse[0]![t]!).toBeGreaterThan(byUse[1]![t]!);
      expect(byUse[1]![t]!).toBeGreaterThan(byUse[2]![t]!);
    }
  });

  it("the loss speeds up once the battery is under the replacement threshold", () => {
    // 85% start, 10 points a year, threshold 80: half a year to the threshold, then 15 a year.
    expect(batteryAt(85, 10, 80, 0.5)).toBe(80);
    expect(batteryAt(85, 10, 80, 1.5)).toBe(65);
    expect(batteryAt(85, 10, 80, 100)).toBe(0); // never negative
  });

  it("says when the battery needs replacing, and 0 when it already does", () => {
    const normal = forecastDevice(phone, "normal").battery!;
    expect(normal.replaceInMonths).toBe(Math.round(((86 - 80) / 7) * 12));
    expect(forecastDevice(phone, "heavy").battery!.replaceInMonths).toBeLessThan(normal.replaceInMonths);
    const tired = forecastDevice({ ...phone, checklist: { batteryPct: 74 } }, "normal").battery!;
    expect(tired.replaceInMonths).toBe(0);
  });

  it("guesses the starting battery from age or condition and says it is a guess", () => {
    const stated = forecastDevice(phone).battery!;
    expect(stated.estimated).toBe(false);
    const byAge = forecastDevice({ ...phone, checklist: { ageYears: 2 } }).battery!;
    expect(byAge).toMatchObject({ estimated: true, start: 86 }); // 100 - 7 * 2
    const byCondition = forecastDevice({ ...phone, checklist: {} }).battery!;
    expect(byCondition).toMatchObject({ estimated: true, start: 88 });
  });

  it("devices without a battery have none; appliances get service, not a battery", () => {
    const fridge = forecastDevice({ category: "large_appliance", condition: "good", price: 5_100_000, checklist: { ageYears: 5 } });
    expect(fridge.battery).toBeNull();
    expect(fridge.maintenance.length).toBeGreaterThan(0);
    const monitor = forecastDevice({ category: "monitor", condition: "good", price: 2_750_000, checklist: {} });
    expect(monitor.battery).toBeNull();
    expect(monitor.maintenance).toEqual([]);
  });

  it("service comes sooner with heavier use and is sorted by date", () => {
    const laptop: ForecastInput = { category: "laptop", condition: "good", price: 7_900_000, checklist: { ageYears: 0 } };
    const light = forecastDevice(laptop, "light").maintenance[0]!;
    const heavy = forecastDevice(laptop, "heavy").maintenance[0]!;
    expect(heavy.inMonths).toBeLessThan(light.inMonths);
    for (const u of USAGE_LEVELS) {
      const m = forecastDevice(laptop, u).maintenance;
      expect(m.map((x) => x.inMonths)).toEqual([...m.map((x) => x.inMonths)].sort((a, b) => a - b));
    }
    // An older device is nearer its next service.
    const old = forecastDevice({ ...laptop, checklist: { ageYears: 2.5 } }, "normal").maintenance[0]!;
    expect(old.inMonths).toBeLessThan(forecastDevice(laptop, "normal").maintenance[0]!.inMonths);
  });

  it("every category with a task table has sane intervals", () => {
    for (const tasks of Object.values(MAINTENANCE)) {
      for (const [, [light, normal, heavy]] of tasks) {
        expect(light).toBeGreaterThanOrEqual(normal);
        expect(normal).toBeGreaterThanOrEqual(heavy);
        expect(heavy).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("price estimate starts at today's price, falls, has a widening band and a floor", () => {
    const p = forecastDevice(phone, "normal", 5).price!.series;
    expect(p[0]).toEqual({ year: 0, mid: 5_700_000, low: 5_700_000, high: 5_700_000 });
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.mid).toBeLessThan(p[i - 1]!.mid);
      expect(p[i]!.low).toBeLessThanOrEqual(p[i]!.mid);
      expect(p[i]!.high).toBeGreaterThanOrEqual(p[i]!.mid);
      // The band widens relative to the value (in sum it can shrink with the value itself).
      expect((p[i]!.high - p[i]!.low) / p[i]!.mid).toBeGreaterThan((p[i - 1]!.high - p[i - 1]!.low) / p[i - 1]!.mid);
    }
    expect(p[5]!.mid).toBeGreaterThanOrEqual(5_700_000 * 0.08);
    // Heavier use loses more value, a console holds value better than a phone.
    expect(forecastDevice(phone, "heavy", 3).price!.series[3]!.mid).toBeLessThan(forecastDevice(phone, "light", 3).price!.series[3]!.mid);
    const ps5 = forecastDevice({ category: "console", condition: "good", price: 5_700_000, checklist: {} }, "normal", 3).price!.series[3]!.mid;
    expect(ps5).toBeGreaterThan(forecastDevice(phone, "normal", 3).price!.series[3]!.mid);
  });

  it("a worn battery costs value", () => {
    const fresh = forecastDevice({ ...phone, checklist: { batteryPct: 98 } }, "heavy", 2).price!.series[2]!.mid;
    const worn = forecastDevice({ ...phone, checklist: { batteryPct: 82 } }, "heavy", 2).price!.series[2]!.mid;
    expect(worn).toBeLessThan(fresh);
  });

  it("no price, no price forecast; the horizon is kept between 1 and 5 years; the same input gives the same answer", () => {
    expect(forecastDevice({ ...phone, price: null }).price).toBeNull();
    expect(forecastDevice(phone, "normal", 99).years).toBe(5);
    expect(forecastDevice(phone, "normal", 0).years).toBe(1);
    expect(forecastDevice(phone, "normal", 3)).toEqual(forecastDevice(phone, "normal", 3));
  });
});
