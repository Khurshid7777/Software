import { useEffect, useState } from "react";
import { FORECAST_YEARS, USAGE_LEVELS, type ForecastYears, type UsageLevel } from "@ishonch/shared/client";
import { readPref, writePref } from "./prefs";

/**
 * How the buyer thinks they will use the device and how far ahead to look: kept on the device and shared by the
 * listing page and the comparison, so changing it in one place changes it in the other.
 */
const EVENT = "ishonch:forecast";
export interface ForecastSettings {
  usage: UsageLevel;
  years: ForecastYears;
}

export function readForecastSettings(): ForecastSettings {
  const usage = readPref("forecast_usage");
  const years = Number(readPref("forecast_years"));
  return {
    usage: (USAGE_LEVELS as readonly string[]).includes(usage ?? "") ? (usage as UsageLevel) : "normal",
    years: (FORECAST_YEARS as readonly number[]).includes(years) ? (years as ForecastYears) : 3,
  };
}

export function useForecastSettings(): [ForecastSettings, (next: Partial<ForecastSettings>) => void] {
  const [s, setS] = useState(readForecastSettings);
  useEffect(() => {
    const sync = () => setS(readForecastSettings());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [
    s,
    (next) => {
      const merged = { ...s, ...next };
      writePref("forecast_usage", merged.usage);
      writePref("forecast_years", String(merged.years));
      window.dispatchEvent(new Event(EVENT));
    },
  ];
}
