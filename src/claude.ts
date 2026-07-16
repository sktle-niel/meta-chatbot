import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { searchProducts, getStockLevels } from "./loyverse.js";

const client = new Anthropic();

const MODEL = "claude-opus-4-8";
const MAX_HISTORY_TURNS = 20; // per-customer memory window

const SYSTEM_PROMPT = `You are a friendly customer service assistant for our store, chatting with customers on Facebook Messenger.

You answer questions about products and stock availability using the tools provided. Always check the tools before making claims about what we carry or what's in stock — never guess.

Guidelines:
- Reply in the same language the customer uses (Filipino/Taglish/English).
- Keep replies short and conversational — this is Messenger, not email. Stay under 1900 characters.
- Prices from the tools are in the store's currency; format them nicely (e.g. ₱150.00).
- If a product isn't found, say so politely and suggest the closest matches if any.
- For questions you can't answer (orders, refunds, complaints), politely say a human staff member will follow up.`;

const searchProductsTool = betaZodTool({
  name: "search_products",
  description:
    "Search the store's product catalog by name, description, or SKU. Call this whenever a customer asks about a product, its price, or whether the store carries it. Returns matching items with their variant IDs and default prices.",
  inputSchema: z.object({
    query: z.string().describe("Search keywords, e.g. 'coke zero' or a SKU"),
  }),
  run: async ({ query }) => {
    const results = await searchProducts(query);
    if (results.length === 0) return `No products matched "${query}".`;
    return JSON.stringify(
      results.map((item) => ({
        name: item.item_name,
        description: item.description,
        variants: item.variants.map((v) => ({
          variant_id: v.variant_id,
          sku: v.sku,
          option: v.option1_value,
          default_price: v.default_price,
        })),
      })),
    );
  },
});

const checkStockTool = betaZodTool({
  name: "check_stock",
  description:
    "Get current stock levels per store for one or more product variants. Call this when a customer asks about availability. Use variant_id values returned by search_products.",
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

export async function answerCustomer(senderId: string, text: string): Promise<string> {
  const history = histories.get(senderId) ?? [];
  history.push({ role: "user", content: text });

  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 2048, // Messenger caps messages at 2000 chars, so replies are short
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    tools: [searchProductsTool, checkStockTool],
    messages: history,
    max_iterations: 8,
  });

  const reply = finalMessage.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // Store only the text turns — tool calls don't need to survive across turns,
  // and this keeps the history valid (no dangling tool_use blocks).
  history.push({ role: "assistant", content: reply || "(no reply)" });
  histories.set(senderId, history.slice(-MAX_HISTORY_TURNS * 2));

  return reply || "Pasensya na po, hindi ko po masagot yan ngayon. May staff po na tutulong sa inyo shortly.";
}
