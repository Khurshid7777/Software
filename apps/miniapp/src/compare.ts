import { useEffect, useState } from "react";
import { COMPARE_MAX } from "@ishonch/shared/client";
import { readPref, writePref } from "./prefs";

/**
 * «Versus»: listings the buyer put side by side. Lives on the device (like "recently viewed"), so it needs no
 * account and no server; every screen that shows a compare button listens for changes through one event.
 */
const KEY = "compare";
const EVENT = "ishonch:compare";

export function readCompare(): string[] {
  return (readPref(KEY) ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
}

function write(ids: string[]) {
  writePref(KEY, ids.join(","));
  window.dispatchEvent(new Event(EVENT));
}

/** Adds or removes a listing; returns `false` when the list is full (the caller shows a hint). */
export function toggleCompare(id: string): boolean {
  const ids = readCompare();
  if (ids.includes(id)) {
    write(ids.filter((x) => x !== id));
    return true;
  }
  if (ids.length >= COMPARE_MAX) return false;
  write([...ids, id]);
  return true;
}

export function removeFromCompare(id: string) {
  write(readCompare().filter((x) => x !== id));
}

export function clearCompare() {
  write([]);
}

/** Replaces the list (e.g. "compare with similar": the open listing plus the closest matches). */
export function setCompare(ids: string[]) {
  write([...new Set(ids)].slice(0, COMPARE_MAX));
}

/** The current compare list, updated whenever any screen changes it. */
export function useCompare(): string[] {
  const [ids, setIds] = useState(readCompare);
  useEffect(() => {
    const sync = () => setIds(readCompare());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return ids;
}
