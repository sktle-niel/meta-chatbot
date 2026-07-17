import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { answerCustomer } from "./claude.js";
import { checkLimits, getCachedReply, recordExchange } from "./guards.js";
import { getAllItems, getTargetStore } from "./loyverse.js";
import { sendTextMessage, sendTypingIndicator } from "./messenger.js";

const app = express();
// Keep the raw body around — Meta signs it and we verify that signature below.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with
 * the App Secret). Without this, anyone who discovers the URL can feed us fake
 * "customer messages" and burn our API credits.
 */
function verifySignature(req: express.Request): boolean {
  const secret = process.env.APP_SECRET;
  if (!secret) return true; // not configured yet — allow, but warn at startup
  const signature = req.headers["x-hub-signature-256"];
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (typeof signature !== "string" || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Webhook verification — Meta calls this once when you register the webhook URL.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Incoming messages from Messenger.
app.post("/webhook", (req, res) => {
  if (!verifySignature(req)) {
    console.warn("Rejected webhook call with bad/missing signature");
    res.sendStatus(403);
    return;
  }
  // Acknowledge immediately — Meta retries (and eventually disables the webhook)
  // if we take too long, and Claude + Loyverse calls can take several seconds.
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "page") return;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId: string | undefined = event.sender?.id;
      const text: string | undefined = event.message?.text;
      // Customers often send a photo of the part they're looking for.
      const imageUrls: string[] = (event.message?.attachments ?? [])
        .filter((a: any) => a.type === "image" && a.payload?.url)
        .map((a: any) => a.payload.url as string);
      // Ignore echoes of our own messages, delivery receipts, etc.
      if (!senderId || (!text && imageUrls.length === 0) || event.message?.is_echo) continue;

      // Free anti-spam checks before any paid Claude call.
      const guard = checkLimits(senderId);
      if (guard.action === "ignore") continue;
      if (guard.action === "reply") {
        console.log(`[${senderId}] rate-limited`);
        sendTextMessage(senderId, guard.message).catch(() => {});
        continue;
      }
      const cached = getCachedReply(senderId, text ?? "", imageUrls.length > 0);
      if (cached) {
        console.log(`[${senderId}] duplicate message — reusing last reply`);
        sendTextMessage(senderId, cached).catch(() => {});
        continue;
      }

      // Cap input size so one giant message can't burn a pile of tokens.
      handleMessage(senderId, (text ?? "").slice(0, 1500), imageUrls.slice(0, 3)).catch((err) => {
        console.error("Failed to handle message:", err);
        sendTextMessage(
          senderId,
          "Pasensya na po, may problema sa system namin ngayon. Paki-try ulit mamaya. 🙏",
        ).catch(() => {});
      });
    }
  }
});

async function handleMessage(senderId: string, text: string, imageUrls: string[] = []): Promise<void> {
  console.log(`[${senderId}] ${text}${imageUrls.length ? ` (+${imageUrls.length} photo/s)` : ""}`);
  await sendTypingIndicator(senderId, true);
  try {
    const reply = await answerCustomer(senderId, text, imageUrls);
    console.log(`[${senderId}] -> ${reply}`);
    recordExchange(senderId, text, reply);
    await sendTextMessage(senderId, reply);
  } finally {
    await sendTypingIndicator(senderId, false);
  }
}

app.get("/", (_req, res) => {
  res.send("Loyverse Messenger chatbot is running");
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  console.log(`Webhook endpoint: http://localhost:${port}/webhook`);
  if (!process.env.APP_SECRET) {
    console.warn(
      "WARNING: APP_SECRET is not set — webhook signature verification is OFF. " +
        "Get it from Meta App Dashboard > App settings > Basic > App secret.",
    );
  }
});

// Warm the caches at startup — Loyverse takes a minute+ to answer from this
// network, and the first customer shouldn't be the one waiting on it.
(async () => {
  try {
    const store = await getTargetStore();
    console.log(store ? `Answering for store: ${store.name}` : "Answering for all stores");
    const items = await getAllItems();
    console.log(`Product cache warmed: ${items.length} items`);
  } catch (err) {
    console.error("Startup cache warm failed (will retry on first message):", err);
  }
})();
