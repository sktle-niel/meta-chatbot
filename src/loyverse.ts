// Thin client for the Loyverse API (https://developer.loyverse.com/docs/)
// Products are cached in memory so we stay well under Loyverse's rate limits.

const BASE_URL = "https://api.loyverse.com/v1.0";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface LoyverseVariant {
  variant_id: string;
  sku: string | null;
  option1_value: string | null;
  option2_value: string | null;
  option3_value: string | null;
  default_price: number | null;
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

/** Case-insensitive search across item names, descriptions, and variant SKUs. */
export async function searchProducts(query: string): Promise<LoyverseItem[]> {
  const items = await getAllItems();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const haystack = [
        item.item_name,
        item.description ?? "",
        ...item.variants.flatMap((v) => [v.sku ?? "", v.option1_value ?? ""]),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .slice(0, 10); // keep tool results small
}

/** Stock levels per store for the given variant IDs, with store names resolved. */
export async function getStockLevels(
  variantIds: string[],
): Promise<Array<{ variant_id: string; store: string; in_stock: number }>> {
  if (variantIds.length === 0) return [];
  const [inventory, stores] = await Promise.all([
    loyverseGet<{ inventory_levels: InventoryLevel[] }>("/inventory", {
      variant_ids: variantIds.join(","),
    }),
    getStores(),
  ]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  return inventory.inventory_levels.map((lvl) => ({
    variant_id: lvl.variant_id,
    store: storeName.get(lvl.store_id) ?? lvl.store_id,
    in_stock: lvl.in_stock,
  }));
}
