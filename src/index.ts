import "dotenv/config";
import express from "express";
import { answerCustomer } from "./claude.js";
import { getAllItems, getTargetStore } from "./loyverse.js";
import { sendTextMessage, sendTypingIndicator } from "./messenger.js";

const app = express();
app.use(express.json());

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

      handleMessage(senderId, text ?? "", imageUrls).catch((err) => {
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
