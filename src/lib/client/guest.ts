"use client";

/**
 * Guest display name + a random browser key, remembered in localStorage.
 * This identifies the commenter on this browser; it is NOT authentication.
 * Access is granted solely by the review link token.
 */

const NAME_KEY = "rr.guest.name";
const KEY_KEY = "rr.guest.key";

function randomKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function getGuestKey(): string {
  try {
    let key = localStorage.getItem(KEY_KEY);
    if (!key || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
      key = randomKey();
      localStorage.setItem(KEY_KEY, key);
    }
    return key;
  } catch {
    // storage blocked (private mode): fall back to a per-tab key
    const w = window as unknown as { __rrGuestKey?: string };
    w.__rrGuestKey ??= randomKey();
    return w.__rrGuestKey;
  }
}

export function getGuestName(): string | null {
  try {
    const n = localStorage.getItem(NAME_KEY);
    return n && n.trim() ? n : null;
  } catch {
    return (window as unknown as { __rrGuestName?: string }).__rrGuestName ?? null;
  }
}

export function setGuestName(name: string) {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
  try {
    localStorage.setItem(NAME_KEY, clean);
  } catch {
    (window as unknown as { __rrGuestName?: string }).__rrGuestName = clean;
  }
  return clean;
}
