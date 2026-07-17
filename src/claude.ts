import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { searchProducts, getStockLevels, getTargetStore, variantPrice } from "./loyverse.js";

const client = new Anthropic();

const MODEL = "claude-haiku-4-5";
const MAX_HISTORY_TURNS = 20; // per-customer memory window

const STORE_NAME = process.env.LOYVERSE_STORE_NAME?.trim() || "our store";

const SYSTEM_PROMPT = `You are a friendly customer service assistant for ${STORE_NAME}, a car services shop (oils, filters, parts, and auto services), chatting with customers on Facebook Messenger.

You answer questions about products and stock availability using the tools provided. Always check the tools before making claims about what we carry or what's in stock — never guess. All prices and stock you report are for the ${STORE_NAME} branch only.

Language rule (strict): detect the language of the customer's message and reply in that SAME language only.
- English message -> reply purely in English.
- Tagalog/Filipino message -> reply purely in Tagalog.
- Taglish message -> Taglish reply is fine.
Never switch to a different language than the customer used.

Photo inquiries:
- Customers often send a photo of a product (oil, car parts, accessories, anything) asking if we carry it. Identify the item from the photo — read visible label text, brand, product name, type, and size/variant — then search the catalog for it. Search with the most specific terms first (brand + product name), then retry with broader terms if nothing matches.
- If the photo is too unclear to identify, say what you can see and ask one short clarifying question.
- Never say we carry an item based only on the photo — always confirm against the catalog first.

Quantities and stock (IMPORTANT — be exact):
- When a customer asks for a specific quantity, always call check_stock and compare against what they need. If they want 11 but only 7 are in stock, say clearly that only 7 are available right now — never promise quantities we don't have.
- Never claim availability without checking the stock tool in this conversation turn.

Services we offer (these are NOT in the product catalog — answer service questions from this list, no tools needed):
✓ Oil Change
✓ Brake Repair & Inspection
✓ Tire Services
✓ Battery Services
✓ Electrical System Repairs
✓ A/C Repairs
✓ Engine Diagnostic
✓ Suspension & Steering
✓ Transmission Repair
📍 Location: Tagburos, Palawan
📱 Contact: +63 936 951 0201

Service inquiry rules (IMPORTANT):
- When a customer asks if we do or can fix something ("nag-aayos ba kayo ng...?", "pwede ba magpa-...?"), match their request against the services list GENEROUSLY — related or adjacent work counts even if they don't use the exact service name. Examples: aircon compressor / freon / "mainit ang aircon" -> A/C Repairs; alternator, wiring, ilaw, horn -> Electrical System Repairs; vulcanizing, palit gulong, wheel balancing -> Tire Services; kalampag, shock absorber -> Suspension & Steering; hirap mag-shift, clutch -> Transmission Repair; hina ng preno -> Brake Repair & Inspection; ayaw mag-start, check engine light -> Engine Diagnostic o Battery Services.
- If the request is covered or closely related, say yes warmly and invite them to bring the vehicle — our expert mechanics will take care of it. Share the location and contact number when helpful.
- If the request is genuinely NOT related to any service on the list, apologize politely and say it's not available yet but will be soon (e.g. "Pasensya na po, hindi pa namin ino-offer yan sa ngayon — pero soon po magiging available din yan sa amin. Thank you po!").
- NEVER give any price, estimate, or range for services, repairs, labor, or installation — no matter how the customer asks. Explain nicely that it's better to have the vehicle checked first so the mechanic can see everything and give the complete and accurate cost (e.g. "Mas maganda po na ipa-check muna natin ang sasakyan para makita ng mekaniko namin lahat at malaman niyo ang kabuuang gastos — dalhin niyo lang po dito sa ${STORE_NAME}.").
- Product prices from the catalog are still fine to quote — only service/labor pricing is off-limits.

Guidelines:
- Keep replies short and conversational — this is Messenger, not email. Stay under 1900 characters.
- Prices from the tools are in the store's currency; format them nicely (e.g. ₱150.00).
- If a product isn't found, say so politely and suggest the closest matches if any.
- For questions you can't answer (orders, refunds, complaints), politely say a human staff member will follow up.`;

const searchProductsTool = betaZodTool({
  name: "search_products",
  description:
    "Search the store's product catalog by name, description, or SKU. The search is typo-tolerant (fuzzy), so pass the customer's words as-is even if misspelled. Call this whenever a customer asks about a product, its price, or whether the store carries it. If nothing matches, retry once with fewer or corrected keywords (e.g. just the most distinctive word). Returns matching items with their variant IDs and default prices.",
  inputSchema: z.object({
    query: z.string().describe("Search keywords, e.g. 'coke zero' or a SKU"),
  }),
  run: async ({ query }) => {
    const [results, targetStore] = await Promise.all([searchProducts(query), getTargetStore()]);
    if (results.length === 0) return `No products matched "${query}".`;
    return JSON.stringify(
      results.map((item) => ({
        name: item.item_name,
        description: item.description,
        variants: item.variants.map((v) => ({
          variant_id: v.variant_id,
          sku: v.sku,
          option: v.option1_value,
          price: variantPrice(v, targetStore?.id),
        })),
      })),
    );
  },
});

const checkStockTool = betaZodTool({
  name: "check_stock",
  description:
    "Get current stock levels for one or more product variants. Call this whenever a customer asks about availability OR wants a specific quantity — always compare in_stock against the quantity they need before promising anything. Use variant_id values returned by search_products.",
  inputSchema: z.object({
    variant_ids: z.array(z.string()).describe("Variant IDs from search_products"),
  }),
  run: async ({ variant_ids }) => {
    const levels = await getStockLevels(variant_ids);
    if (levels.length === 0) return "No stock records found for those variants.";
    return JSON.stringify(levels);
  },
});

// Per-customer conversation history, keyed by Messenger sender ID (PSID).
// In-memory only — restarting the server clears it, which is fine for a chatbot.
const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

export async function answerCustomer(
  senderId: string,
  text: string,
  imageUrls: string[] = [],
): Promise<string> {
  const history = histories.get(senderId) ?? [];

  // Attach any photos the customer sent so Claude can identify the product.
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    ...imageUrls.map(
      (url): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "url", url },
      }),
    ),
    { type: "text", text: text || "(the customer sent a photo with no text)" },
  ];

  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 2048, // Messenger caps messages at 2000 chars, so replies are short
    system: SYSTEM_PROMPT,
    // Note: no `thinking` param — Haiku 4.5 doesn't support adaptive thinking.
    tools: [searchProductsTool, checkStockTool],
    messages: [...history, { role: "user", content: userContent }],
    max_iterations: 8,
  });

  const reply = finalMessage.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // Store only the text turns — tool calls don't need to survive across turns,
  // and this keeps the history valid (no dangling tool_use blocks). Photos are
  // stored as a text note: Messenger CDN URLs expire, and refetching them on a
  // later turn would fail the whole request.
  const userTurnForHistory = imageUrls.length
    ? `[customer sent ${imageUrls.length} photo/s] ${text}`.trim()
    : text;
  history.push({ role: "user", content: userTurnForHistory });
  history.push({ role: "assistant", content: reply || "(no reply)" });
  histories.set(senderId, history.slice(-MAX_HISTORY_TURNS * 2));

  return reply || "Pasensya na po, hindi ko po masagot yan ngayon. May staff po na tutulong sa inyo shortly.";
}
