// Messenger Send API helpers (https://developers.facebook.com/docs/messenger-platform)

const GRAPH_URL = "https://graph.facebook.com/v21.0/me/messages";

async function callSendApi(body: object): Promise<void> {
  const url = `${GRAPH_URL}?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Messenger Send API ${res.status}:`, await res.text());
  }
}

export async function sendTextMessage(recipientId: string, text: string): Promise<void> {
  // Messenger rejects messages over 2000 chars — split long replies.
  const chunks = text.match(/[\s\S]{1,1900}/g) ?? [];
  for (const chunk of chunks) {
    await callSendApi({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text: chunk },
    });
  }
}

/** Shows the "typing…" indicator while Claude is working. */
export async function sendTypingIndicator(recipientId: string, on: boolean): Promise<void> {
  await callSendApi({
    recipient: { id: recipientId },
    sender_action: on ? "typing_on" : "typing_off",
  });
}
