// What the site keeps between visits, in this browser only: saved villages and settings.
// Storage may be missing or full; every call fails quietly and the site works without it.

export interface SavedVillage {
  id: string;
  tag: string;
  townHall: number;
  exportedAt: number;
  savedAt: number;
  text: string;
}

const KEYS = {
  villages: "maxplanner.villages",
  settings: "maxplanner.settings",
  current: "maxplanner.current",
};
const MAX_VILLAGES = 12;

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: nothing is kept, and that is fine.
  }
}

export const store = {
  villages: (): SavedVillage[] => read<SavedVillage[]>(KEYS.villages) ?? [],
  saveVillage(v: Omit<SavedVillage, "id" | "savedAt">, now: number): SavedVillage {
    const saved: SavedVillage = { ...v, id: `${v.tag}@${v.exportedAt}`, savedAt: now };
    const rest = store.villages().filter((x) => x.id !== saved.id);
    write(KEYS.villages, [saved, ...rest].slice(0, MAX_VILLAGES));
    return saved;
  },
  removeVillage(id: string) {
    write(
      KEYS.villages,
      store.villages().filter((x) => x.id !== id),
    );
    if (store.current() === id) store.setCurrent(undefined);
  },
  current: (): string | undefined => read<string>(KEYS.current),
  setCurrent: (id: string | undefined) => write(KEYS.current, id),
  settings: <T>(): Partial<T> | undefined => read<Partial<T>>(KEYS.settings),
  saveSettings: (s: unknown) => write(KEYS.settings, s),
};
