// Thin client for the Loyverse API (https://developer.loyverse.com/docs/)
// Products are cached in memory so we stay well under Loyverse's rate limits.

const BASE_URL = "https://api.loyverse.com/v1.0";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface VariantStoreInfo {
  store_id: string;
  price: number | null;
  available_for_sale: boolean;
}

export interface LoyverseVariant {
  variant_id: string;
  sku: string | null;
  option1_value: string | null;
  option2_value: string | null;
  option3_value: string | null;
  default_price: number | null;
  stores?: VariantStoreInfo[] | null;
}

export interface LoyverseItem {
  id: string;
  item_name: string;
  description: string | null;
  variants: LoyverseVariant[];
}

interface InventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
}

interface Store {
  id: string;
  name: string;
}

async function loyverseGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.LOYVERSE_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Loyverse API ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

let itemsCache: { items: LoyverseItem[]; fetchedAt: number } | null = null;
let storesCache: Store[] | null = null;

/** All items, following pagination, cached for 5 minutes. */
export async function getAllItems(): Promise<LoyverseItem[]> {
  if (itemsCache && Date.now() - itemsCache.fetchedAt < CACHE_TTL_MS) {
    return itemsCache.items;
  }

  const items: LoyverseItem[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { limit: "250" };
    if (cursor) params.cursor = cursor;
    const page = await loyverseGet<{ items: LoyverseItem[]; cursor?: string }>("/items", params);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  itemsCache = { items, fetchedAt: Date.now() };
  return items;
}

export async function getStores(): Promise<Store[]> {
  if (!storesCache) {
    const res = await loyverseGet<{ stores: Store[] }>("/stores");
    storesCache = res.stores;
  }
  return storesCache;
}

/**
 * The single store/branch this bot answers for, resolved from the
 * LOYVERSE_STORE_NAME env var (e.g. "FOUR WHEELS ZONE"). Returns null when
 * the env var is unset, meaning the bot covers all stores.
 */
export async function getTargetStore(): Promise<Store | null> {
  const name = process.env.LOYVERSE_STORE_NAME?.trim();
  if (!name) return null;
  const stores = await getStores();
  const lower = name.toLowerCase();
  const store =
    stores.find((s) => s.name.toLowerCase() === lower) ??
    stores.find((s) => s.name.toLowerCase().includes(lower));
  if (!store) {
    throw new Error(
      `LOYVERSE_STORE_NAME "${name}" did not match any store. Available: ${stores
        .map((s) => s.name)
        .join(", ")}`,
    );
  }
  return store;
}

/** True when the variant is sold at the given store (assumes yes if Loyverse omits store data). */
function availableAtStore(variant: LoyverseVariant, storeId: string): boolean {
  const info = variant.stores?.find((s) => s.store_id === storeId);
  return info ? info.available_for_sale : true;
}

/** The price at the given store when set, falling back to the variant's default price. */
export function variantPrice(variant: LoyverseVariant, storeId?: string): number | null {
  if (storeId) {
    const info = variant.stores?.find((s) => s.store_id === storeId);
    if (info && info.price != null) return info.price;
  }
  return variant.default_price;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, " "); // punctuation/dashes become word breaks
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[n];
}

/**
 * 0..1 similarity between one query term and one catalog word.
 * Exact and substring matches score highest; otherwise edit distance,
 * so typos like "brek" -> "brake" or "kalbarator" -> "carburetor" still match.
 */
function termSimilarity(term: string, word: string): number {
  if (word === term) return 1;
  if (word.startsWith(term) || term.startsWith(word)) return 0.95;
  if (word.includes(term) || term.includes(word)) return 0.9;
  const dist = levenshtein(term, word);
  return 1 - dist / Math.max(term.length, word.length);
}

// A term must be at least this similar to some word in the item to count as a hit.
// Short words tolerate ~1 typo, longer words ~2-3.
const MIN_TERM_SCORE = 0.6;

/**
 * Typo-tolerant search across item names, descriptions, and variant SKUs.
 * Each query term is fuzzy-matched against the item's words; items where
 * every term found a close-enough word are ranked by overall similarity.
 * When LOYVERSE_STORE_NAME is set, only items sold at that store are returned.
 */
export async function searchProducts(query: string): Promise<LoyverseItem[]> {
  const [items, targetStore] = await Promise.all([getAllItems(), getTargetStore()]);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ item: LoyverseItem; score: number }> = [];
  for (const item of items) {
    if (targetStore && !item.variants.some((v) => availableAtStore(v, targetStore.id))) {
      continue;
    }
    const words = normalize(
      [
        item.item_name,
        item.description ?? "",
        ...item.variants.flatMap((v) => [v.sku ?? "", v.option1_value ?? ""]),
      ].join(" "),
    )
      .split(/\s+/)
      .filter(Boolean);

    let total = 0;
    let allTermsHit = true;
    for (const term of terms) {
      let best = 0;
      for (const word of words) {
        const s = termSimilarity(term, word);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (best < MIN_TERM_SCORE) {
        allTermsHit = false;
        break;
      }
      total += best;
    }
    if (allTermsHit) scored.push({ item, score: total / terms.length });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10) // keep tool results small
    .map((s) => s.item);
}

/**
 * Stock levels for the given variant IDs, with store names resolved.
 * When LOYVERSE_STORE_NAME is set, only that store's stock is returned.
 */
export async function getStockLevels(
  variantIds: string[],
): Promise<Array<{ variant_id: string; store: string; in_stock: number }>> {
  if (variantIds.length === 0) return [];
  const targetStore = await getTargetStore();
  const params: Record<string, string> = { variant_ids: variantIds.join(",") };
  if (targetStore) params.store_ids = targetStore.id;
  const [inventory, stores] = await Promise.all([
    loyverseGet<{ inventory_levels: InventoryLevel[] }>("/inventory", params),
    getStores(),
  ]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  return inventory.inventory_levels.map((lvl) => ({
    variant_id: lvl.variant_id,
    store: storeName.get(lvl.store_id) ?? lvl.store_id,
    in_stock: lvl.in_stock,
  }));
}
