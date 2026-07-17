// Free pre-checks that run BEFORE any paid Claude call: per-sender rate
// limits, duplicate-message detection, and a global daily budget. Sending
// Messenger replies is free — only Claude calls cost money.

const WINDOW_MS = 60_000; // burst window per sender
const MAX_PER_WINDOW = 5; // messages per sender per minute
const MAX_PER_DAY = 40; // messages per sender per day
const GLOBAL_MAX_PER_DAY = 500; // Claude calls per day, all customers combined
const DUPLICATE_TTL_MS = 5 * 60_000; // repeated identical message -> reuse last answer
const DAY_MS = 24 * 60 * 60 * 1000;

const RATE_LIMIT_MESSAGE =
  "Pasensya na po, sandali lang po muna — marami po tayong messages ngayon. 🙏 Kung urgent po, tawagan niyo kami sa +63 936 951 0201.";
const BUDGET_MESSAGE =
  "Pasensya na po, magpapahinga muna saglit ang aming chatbot. May staff po na sasagot sa inyo dito, o tawagan niyo po kami sa +63 936 951 0201. 🙏";

interface SenderState {
  recent: number[]; // timestamps inside the burst window
  dayStart: number;
  dayCount: number;
  warned: boolean; // one canned warning per limit episode, then silence
  lastText: string | null;
  lastReply: string | null;
  lastReplyAt: number;
}

const senders = new Map<string, SenderState>();
let globalDay = { start: Date.now(), count: 0, warned: new Set<string>() };

function getSender(senderId: string): SenderState {
  let s = senders.get(senderId);
  if (!s) {
    s = {
      recent: [],
      dayStart: Date.now(),
      dayCount: 0,
      warned: false,
      lastText: null,
      lastReply: null,
      lastReplyAt: 0,
    };
    senders.set(senderId, s);
  }
  return s;
}

export type GuardResult =
  | { action: "allow" }
  | { action: "ignore" }
  | { action: "reply"; message: string };

/** Decide whether this incoming message may trigger a (paid) Claude call. */
export function checkLimits(senderId: string): GuardResult {
  const now = Date.now();

  if (now - globalDay.start >= DAY_MS) {
    globalDay = { start: now, count: 0, warned: new Set() };
  }
  const s = getSender(senderId);
  if (now - s.dayStart >= DAY_MS) {
    s.dayStart = now;
    s.dayCount = 0;
    s.warned = false;
  }
  s.recent = s.recent.filter((t) => now - t < WINDOW_MS);

  // Whole-bot daily budget: protects the API balance no matter how many senders.
  if (globalDay.count >= GLOBAL_MAX_PER_DAY) {
    if (!globalDay.warned.has(senderId)) {
      globalDay.warned.add(senderId);
      return { action: "reply", message: BUDGET_MESSAGE };
    }
    return { action: "ignore" };
  }

  // Per-sender limits: one polite warning, then silence until they slow down.
  if (s.recent.length >= MAX_PER_WINDOW || s.dayCount >= MAX_PER_DAY) {
    if (!s.warned) {
      s.warned = true;
      return { action: "reply", message: RATE_LIMIT_MESSAGE };
    }
    return { action: "ignore" };
  }

  s.warned = false;
  s.recent.push(now);
  s.dayCount++;
  globalDay.count++;
  return { action: "allow" };
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * If the sender repeats the exact same message within a few minutes,
 * reuse the previous answer instead of paying for a new Claude call.
 */
export function getCachedReply(senderId: string, text: string, hasImages: boolean): string | null {
  if (hasImages || !text) return null;
  const s = senders.get(senderId);
  if (!s || !s.lastText || !s.lastReply) return null;
  if (Date.now() - s.lastReplyAt > DUPLICATE_TTL_MS) return null;
  return normalize(text) === s.lastText ? s.lastReply : null;
}

export function recordExchange(senderId: string, text: string, reply: string): void {
  const s = getSender(senderId);
  s.lastText = text ? normalize(text) : null;
  s.lastReply = reply;
  s.lastReplyAt = Date.now();
}
