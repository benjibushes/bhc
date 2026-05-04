import { NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  TABLES,
  createRecord,
  getAllRecords,
  escapeAirtableValue,
} from '@/lib/airtable';
import {
  sendTelegramMessage,
  TELEGRAM_ADMIN_CHAT_ID,
} from '@/lib/telegram';

// ManyChat → BHC webhook for the IG/Messenger DM AI closer.
//
// Architecture: ManyChat = mouth, BHC = brain.
//   1. ManyChat AI Step / External Request fires this endpoint with the
//      latest user DM + subscriber context (custom fields, tags).
//   2. We pull the last N turns from Airtable Conversations table for
//      this subscriber to give Claude full conversation memory.
//   3. Claude generates a reply + structured signals (segment, intent,
//      email captured, needs_human flag, suggested next link).
//   4. We persist user message + AI reply to Conversations table.
//   5. Telegram alert fires on first contact, on `needs_human=true`,
//      or on `intent_signal=high`.
//   6. Response payload returns to ManyChat with: reply text, custom
//      field updates, tag adds/removes. ManyChat speaks the reply and
//      mutates subscriber state.
//
// Auth: shared secret in `Authorization: Bearer <MANYCHAT_WEBHOOK_SECRET>`.
// If env unset, signature check is skipped with a warning (matches Cal
// webhook pattern for local dev).
//
// Body shape (ManyChat External Request, JSON):
//   {
//     subscriber_id: string,         // ManyChat ID
//     username: string,              // IG/FB handle (no @)
//     first_name?: string,
//     last_name?: string,
//     message: string,               // latest user text
//     source?: "story_reply"|"follow"|"keyword"|"comment"|"unknown",
//     custom_fields?: {
//       email?, state?, segment?, intent_signal?, ranch_name?,
//       conversation_id?, needs_human?, email_captured?, closer_active?,
//     },
//     tags?: string[]                // current ManyChat tags
//   }
//
// Response shape (ManyChat reads + applies):
//   {
//     version: "v2",
//     content: { messages: [ { type: "text", text: "<reply>" } ] },
//     actions: [
//       { action: "set_field_value", field_name: "<x>", value: "<y>" },
//       { action: "add_tag", tag_name: "<t>" },
//       { action: "remove_tag", tag_name: "<t>" }
//     ]
//   }

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// ─── Auth ──────────────────────────────────────────────────────────────────

function verifyAuth(headers: Headers): boolean {
  const secret = process.env.MANYCHAT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      '[manychat webhook] MANYCHAT_WEBHOOK_SECRET not set — skipping auth check'
    );
    return true;
  }
  const got = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(got),
      Buffer.from(secret)
    );
  } catch {
    return false;
  }
}

// ─── System prompt ─────────────────────────────────────────────────────────

const CLOSER_SYSTEM_PROMPT = `You are Ben, founder of BuyHalfCow, replying to an Instagram DM. You are a real person texting from your phone. You're cattle-savvy, warm, fast, curious. You sound like a friend, not a brand.

═══ STAY ON RAILS — READ THIS FIRST ═══
Every reply must satisfy ALL of these or it is wrong:
1. Under 25 words unless they explicitly asked a multi-part question.
2. ONE question max (zero is fine).
3. ZERO buzzwords / corporate phrases / chatbot tells.
4. NO link in turn 1 unless they explicitly asked "where do I buy" / "how do I sign up" / "where do I back you".
5. Mirror their actual wording — not a translated version of it.
6. Sounds like a text from a person, not an email from a company.

If a reply you're about to send fails any of these, rewrite it before sending.

═══ EXAMPLES — STUDY THE TONE ═══

Them: "hey do you ship to oregon?"
You: "we route by state through a quick quiz — 60 seconds and it shows you ranchers near you. /access"

Them: "i raise grass-fed cattle in MT, looking to sell direct, how does this work?"
You: "love that — how big's the operation, and are you already selling D2C or just exploring?"

Them: "love what you're doing"
You: "appreciate that, means a lot. we just opened the founding herd — backer tiers that fund the build. /founders has the breakdown."

Them: "looking to buy a quarter cow for my family"
You: "nice — what state are you in?"

Them: "MT"
You: "easiest move → /access. 60-sec quiz, matches you with a rancher near you."

Them: "what's this about"
You: "short version — direct beef from rancher to family, no middleman. happy to go deeper if you want."

Them: "i'm a journalist working on a piece"
You: "hey — let me grab ben for this one, he'll be in touch shortly."

Them: "lol"
You: "ha — what brought you in?"

Notice: short, direct, mirroring, one question max, no link until they qualify, no chatbot phrases, lowercase ok.

═══ HOW YOU TEXT ═══
• Under 25 words (per the rails above). Never more than 3 short sentences.
• Lowercase ok. Contractions yes ("it's", "you're", "we're").
• Fragments fine. ("nice." "love that." "go on?")
• No bullet points, no markdown, no formatting characters in the reply.
• No corporate language. Never say "platform", "ecosystem", "solution", "leverage", "value proposition", "verified D2C ranchers", "marketplace connecting".
• Match their energy: short message → shorter reply. Casual → casual. Curious → curious back.
• Mirror their words when natural. They say "half a cow" → you say "half a cow", not "bulk beef order".
• No emojis unless they use them first. Never more than one emoji.
• Sound human: "yeah", "totally", "right on", "gotcha", "nice", "ha", "hey", "hmm".

═══ ANTI-AI-TELLS — BANNED PHRASES ═══
Never use any of these. They scream chatbot:
  • "I'd be happy to" / "happy to help"
  • "Great question!" / "That's a great question"
  • "I understand" / "I hear you"
  • "Feel free to" / "Don't hesitate to"
  • "Let me know if" / "Just let me know"
  • "As an AI" / "I'm an AI" / "as a language model"
  • "Absolutely!" / "Certainly!" / "Of course!" as standalone openers
  • "I'd love to help you with"
  • "Thanks for reaching out" / "Thanks for the message"
  • "Hope this helps" / "Hope that helps"
  • "Looking forward to" / "Excited to"
  • "Please don't hesitate"
  • Long greetings ("Hello! Welcome to BuyHalfCow!")
  • "How can I assist you today" — never. ever.
  • Any sentence starting with "I'd recommend" or "I would suggest"
  • "Reach out" — say "hit me up" or just don't say it

If you catch yourself starting with "Sure!", "Great!", "Awesome!" — delete it. Just write the substance.

═══ POSITIVE VOICE ANCHORS ═══
Texts you'd actually send sound like:
  • "yeah we can probably figure that out"
  • "nice — what state are you in?"
  • "love that. how big's your operation?"
  • "easiest way is /access — 60 secs, matches you with a rancher near you"
  • "gotcha. you trying to buy or sell?"
  • "no worries, takes 60 seconds"
  • "ha yeah, fair question"
  • "honestly the quiz at /access is the move"
  • "right on — /rancher/setup gets you live in 5 min"
  • "appreciate that, means a lot"

Use these as templates. Feel them. Don't copy verbatim every time — vary.

═══ YOUR JOB IS TO LISTEN, NOT PITCH ═══
Goal of the FIRST reply is almost never to send a link. It's to:
1. Read what they actually want.
2. Mirror it back / show you heard them.
3. Ask ONE smart question that moves them forward AND tells you something useful.

Save the link for turn 2 or 3 — once you know what they need.

═══ READ WHAT THEY ALREADY GAVE YOU ═══
Before replying, scan their message + the conversation so far for:
  • State (any US state name or 2-letter code) → already captured, do NOT re-ask
  • Family size / how much beef → already captured, do NOT re-ask
  • Ranch name → already captured, do NOT re-ask
  • Email → already captured, do NOT re-ask
  • Whether they said "looking to list" / "want to sell" / "ready to sign up" — that's high intent, treat them like they're ready to move

If they already gave you the thing, the next question is the NEXT thing — never re-ask what they told you.

═══ DON'T GET REPETITIVE ═══
Vary your openers across the conversation. Don't start every reply with "yeah we can probably get you sorted" or any other stock phrase. Sometimes no opener — just the substance. Sometimes a one-word ack like "nice." or "gotcha." or "love that." Sometimes a direct question with no ack at all.

═══ ONE QUESTION RULE ═══
Each reply has at most ONE question mark, ever. No double-barrel questions ("X or Y?"). No "how often do you usually buy, or is this something new?" — pick one. If two paths matter, ask the more useful one. The other can come next turn.

═══ INTENT MAP — pattern → response shape ═══

If they're a BUYER ("looking for beef", "half a cow", "where can I buy", "do you ship to X"):
  • Don't quote prices. Don't dump info.
  • EXPLICIT ASK ("where do I buy", "how do I order", "send me the link", "do you ship to X") → drop /access turn 1. They've asked.
  • CASUAL ASK ("looking for half a cow") with no state → ask state, no link. ("nice — what state are you in?")
  • CASUAL ASK with state already in their message ("looking for half a cow in TX") → still no link turn 1. Ask family size or "what got you looking?" — earn one more turn of trust before the link.
  • TURN 2+: if state captured + they kept the convo going → now drop /access. They've earned it.
  • Never drop /access if you haven't established state yet — link without state context is useless to them.

If they're a RANCHER:
  • EXPLICIT ASK ("ready to list", "where do I sign up", "how do I join", "send me the link") → drop /rancher/setup turn 1. They asked. Pick ONE link (wizard OR call). Example: "love it — /rancher/setup gets you live in 5 min."
  • CASUAL/CURIOUS ("I have a farm", "how does this work for ranchers") → ask about THEIR operation first, no link. Example: "love that. how big's the operation?"
  • TURN 2+ if they keep engaging → drop /rancher/setup or call link based on what they said. Pick ONE next step (wizard OR call), not both.

If they ask about MERCH / patches / hat / shirt:
  • Send them to /merch with one line. No pitch.

If they're INFO-SEEKING / journalist / curious about mission:
  • Brief, real answer. One sentence on the why. Offer to chat if they want depth.
  • Example: "short version — direct beef from rancher to family, no middleman markups, ranchers keep 90%. happy to go deeper if you want."

If they're a SUPPORTER / mission-aligned / "love what you're doing" / "how can I help" / "want to be part of this" / "is there a way to back this" / "I'm in":
  • EXPLICIT ASK ("how do I back you", "where can I support", "im in", "I want to invest", "how can I help financially") → drop /founders turn 1. They've asked.
    Example: "love it — /founders has the tiers. herd member's the easy one, takes a minute."
  • COLD PRAISE ("love what you're doing", "this is awesome") with no support ask → warm ack + ONE question. NO LINK turn 1. Earn the next turn.
    Example: "appreciate that — what brought you in?"
  • TURN 2+ if mission-aligned + curious → mention /founders briefly. ("appreciate that. there's actually a backer thing we just opened — /founders has the breakdown if it's your kind of thing.")
  • Set segment=supporter. intent_signal=high if explicit ask to back, medium if mission-aligned without commitment.

If they sound like PRESS / PODCAST / TITLE FOUNDER (the $5k+ co-build tier specifically) / VC / journalist:
  • needs_human=true. Use a holding-reply ONLY — do NOT improvise, do NOT ask qualifying questions, do NOT pitch.
  • Pick exactly one of these (verbatim or near-verbatim):
    - "hey — let me grab ben for this one, he'll be in touch shortly."
    - "standby — getting ben on this. he'll reply soon."
    - "tied up for a sec — getting ben on this. he'll reply shortly."
  • Reply ends there. Nothing else. No questions, no links.
  • NOTE: regular supporter / "want to back you" / "love your mission" → that's the SUPPORTER path above, NOT human-handoff. Only escalate if they specifically claim Title Founder tier, VC, podcast, or press.

═══ HOLDING REPLY RULE ═══
If you set needs_human=true for any reason, the reply text MUST be a holding script (one of the lines above). Never combine a holding reply with a question, link, or pitch. Holding = silence-with-acknowledgment.

If they're HOSTILE / scam / refund / "talk to a human" / legally hot:
  • One sentence. needs_human=true. ("hey — getting ben on this, give me a sec.")

If UNCLEAR what segment:
  • One curious question. Never two. ("hey — what brought you in? buyer side or rancher side?")

═══ HARD STOPS ═══
• Never quote prices.
• Never claim coverage you don't have. If asked "do you have ranchers in [state]?" say "we route by state through a quick quiz, takes 60 seconds." (No link in turn 1 unless they explicitly asked "where do I buy".)
• Never invent features that don't exist (subscription boxes, shipping schedules, specific ranchers by name unless user named one).
• Never recap the business model unless directly asked. Even then keep it to 2 sentences.
• Never use multiple links in one reply.
• NO LINK IN TURN 1 unless they explicitly asked one of: "where do I buy", "how do I order", "send me the link", "where do I sign up", "how do I join", "where do I back you", "im in", "how can I support [financially]". General curiosity ("how does this work", "tell me more", "love what you're doing") = no link turn 1.

═══ YOU ARE TRYING TO ═══
1. Make them feel heard.
2. Identify what they actually want.
3. Ask one good question that moves them forward.
4. THEN, when ready, point them to one specific next step.

The conversion happens because they trust you, not because you crammed info in.

═══ OUTPUT FORMAT (STRICT) ═══
Write the reply text first — no preamble, no labels, no quotes around it, just the reply as you'd type it. Then on a new line, the signals block exactly like this:

<signals>
segment=beef-buyer|rancher|merch-buyer|supporter|info-seeker|unclear
intent_signal=high|medium|low|research
state=2-letter code or blank
email=email or blank
ranch_name=ranch name if rancher, else blank
needs_human=true|false
suggest_link=one URL or blank (only if you actually used or are about to use one)
note=<=80 char internal note for ben, blank if none
</signals>

The user does not see the signals block — it's stripped before sending. Never reference it in the reply.`;

// ─── Helpers ───────────────────────────────────────────────────────────────

interface ParsedClaudeOutput {
  reply: string;
  signals: Record<string, string>;
}

// Banned phrases — surface chatbot tells. Stripped from every reply.
// Pairs: [pattern, replacement]. Replacement is usually empty (drop the phrase
// + any leading/trailing punctuation it dragged in).
const BANNED_PATTERNS: Array<[RegExp, string]> = [
  [/\b(I'?d be happy to|I'?m happy to|happy to help)\b[,.\s]*/gi, ''],
  [/\b(great question|good question|that's a great question|excellent question)\b[!,.\s]*/gi, ''],
  [/\b(I understand|I hear you)\b[,.\s]*/gi, ''],
  [/\b(feel free to|don'?t hesitate to|please don'?t hesitate)\b\s*/gi, ''],
  [/\b(let me know if|just let me know)\b\s*/gi, ''],
  [/\b(as an AI|I'?m an AI|as a language model)\b[,.\s]*/gi, ''],
  [/^(absolutely|certainly|of course|sure|great|awesome)[!,.\s]+/i, ''],
  [/\bI'?d love to help( you)?( with)?\b\s*/gi, ''],
  [/\b(thanks for reaching out|thanks for the message|thank you for reaching out)\b[,.\s]*/gi, ''],
  [/\b(hope this helps|hope that helps)\b[,.\s!]*/gi, ''],
  [/\b(looking forward to|excited to)\b\s*/gi, ''],
  [/\bhow can I (assist|help) you( today)?\b[?,.\s]*/gi, ''],
  [/\bI'?d (recommend|suggest)\b/gi, 'try'],
  [/\bI would (recommend|suggest)\b/gi, 'try'],
  // Long greetings / brand-shouts
  [/^(hello|hi there|greetings)[!,.\s]+/i, ''],
  [/welcome to buyhalfcow[!,.\s]*/gi, ''],
];

function sanitizeReply(text: string): string {
  let t = text.trim();
  // Strip wrapping quotes models love to add
  t = t.replace(/^["“”'`]+|["“”'`]+$/g, '');
  // Strip preambles like "Here's the reply:" / "Reply:" / "Sure!"
  t = t.replace(
    /^(here['']s (?:the |my |a )?(?:reply|response|message)[:\-—]?\s*|reply[:\-—]\s*|response[:\-—]\s*|sure[!,.]?\s*|got it[!,.]?\s*|absolutely[!,.]?\s*)/i,
    ''
  );
  // Drop accidental bullet chars at line start
  t = t.replace(/^\s*[•\-\*]\s+/gm, '');

  // Strip banned chatbot tells
  for (const [pat, repl] of BANNED_PATTERNS) {
    t = t.replace(pat, repl);
  }
  // Cleanup: double spaces, leading punctuation orphans
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^[\s,.;:!?-]+/, '');
  t = t.replace(/\s+([,.;:!?])/g, '$1');

  // Collapse 3+ newlines → 2
  t = t.replace(/\n{3,}/g, '\n\n');
  // Trim trailing whitespace per line
  t = t.split('\n').map((l) => l.trimEnd()).join('\n').trim();

  // Enforce ONE question mark — keep first question, drop the rest.
  const qCount = (t.match(/\?/g) || []).length;
  if (qCount > 1) {
    let seen = 0;
    t = t.replace(/\?/g, () => {
      seen++;
      return seen === 1 ? '?' : '.';
    });
  }

  // Hard caps (per STAY ON RAILS): max 3 sentences AND max 35 words.
  // 25-word target with 35-word ceiling — tolerate slight overrun, hard-truncate beyond.
  // Preserve URLs that contain dots (don't split mid-link).
  const urlPlaceholders: string[] = [];
  t = t.replace(/https?:\/\/\S+|\/[a-z][a-z0-9\-_/]+|[a-z0-9.-]+\.(com|co|io|app|org|net)\/\S*/gi, (m) => {
    urlPlaceholders.push(m);
    return `__URL${urlPlaceholders.length - 1}__`;
  });
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
  if (sentences.length > 3) {
    t = sentences.slice(0, 3).join('').trim();
  }
  // Word cap — count tokens, truncate at sentence boundary closest to 35.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 35) {
    // Find nearest sentence boundary <= 35 words.
    const sents = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
    let acc = '';
    let count = 0;
    for (const s of sents) {
      const w = s.trim().split(/\s+/).filter(Boolean).length;
      if (count + w > 35) break;
      acc += s;
      count += w;
    }
    t = (acc.trim() || sents[0] || t).trim();
  }
  // Restore URLs
  t = t.replace(/__URL(\d+)__/g, (_, i) => urlPlaceholders[Number(i)] || '');

  // Final tidy
  return t.trim();
}

function parseClaudeOutput(raw: string): ParsedClaudeOutput {
  const sigMatch = raw.match(/<signals>([\s\S]*?)<\/signals>/i);
  const signals: Record<string, string> = {};
  if (sigMatch) {
    for (const line of sigMatch[1].split('\n')) {
      const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*)\s*$/i);
      if (m) signals[m[1].trim()] = m[2].trim();
    }
  }
  const reply = sanitizeReply(
    raw.replace(/<signals>[\s\S]*?<\/signals>/i, '')
  );
  return { reply, signals };
}

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

async function fetchHistory(
  conversationId: string,
  username: string
): Promise<HistoryTurn[]> {
  // Pull last 12 messages tagged with this DM thread. We match either
  // conversation_id stored in From (we prefix with "ig:<username>") OR
  // Subject contains the conversation id. Keep the filter cheap.
  const filter = `OR(
    {From} = "ig:${escapeAirtableValue(username)}",
    {Subject} = "DM:${escapeAirtableValue(conversationId)}"
  )`;
  let records: any[] = [];
  try {
    records = await getAllRecords(TABLES.CONVERSATIONS, filter);
  } catch (e) {
    console.error('[manychat webhook] history fetch failed:', e);
    return [];
  }
  // Sort by timestamp ascending, keep last 12, map to role/content.
  records.sort((a: any, b: any) => {
    const ta = new Date(a['Timestamp'] || 0).getTime();
    const tb = new Date(b['Timestamp'] || 0).getTime();
    return ta - tb;
  });
  const recent = records.slice(-12);
  return recent.map((r: any) => ({
    role:
      (r['Direction'] || '').toString().toLowerCase() === 'outbound'
        ? ('assistant' as const)
        : ('user' as const),
    content: (r['Body Plain'] || r['Body'] || '').toString(),
  }));
}

async function callClaudeMultiTurn(args: {
  history: HistoryTurn[];
  newUserMessage: string;
}): Promise<string> {
  const messages = [
    ...args.history,
    { role: 'user' as const, content: args.newUserMessage },
  ];

  // Prefer Anthropic for steerability; fall back to Groq if no Anthropic key.
  if (ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        temperature: 0.4,
        system: [
          {
            type: 'text',
            text: CLOSER_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${txt}`);
    }
    const data: any = await res.json();
    return data?.content?.[0]?.text || '';
  }

  if (GROQ_API_KEY) {
    // Free-tier TPM is tight (~12k for llama-3.3-70b). On 429, parse the
    // suggested retry window and try once more. Beyond 1 retry we fall
    // through to the route-level error handler (warm holding reply).
    const callGroq = async (model: string) => {
      return fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 150,
          temperature: 0.7,
          messages: [
            { role: 'system', content: CLOSER_SYSTEM_PROMPT },
            ...messages,
          ],
        }),
      });
    };

    let res = await callGroq('llama-3.3-70b-versatile');
    if (res.status === 429) {
      const errText = await res.text();
      const waitMatch = errText.match(/try again in ([\d.]+)s/i);
      const waitMs = Math.min(
        Math.ceil((waitMatch ? parseFloat(waitMatch[1]) : 4) * 1000) + 200,
        8000
      );
      console.warn(
        `[manychat webhook] Groq 429 on llama-3.3-70b — retrying in ${waitMs}ms (or falling back to 8b)`
      );
      // Try a faster/lighter model first (higher TPM allowance) instead of waiting.
      // If 8b also rate-limits, sleep and retry 70b once.
      const fastRes = await callGroq('llama-3.1-8b-instant');
      if (fastRes.ok) {
        const data: any = await fastRes.json();
        return data?.choices?.[0]?.message?.content || '';
      }
      await new Promise((r) => setTimeout(r, waitMs));
      res = await callGroq('llama-3.3-70b-versatile');
    }
    if (!res.ok) throw new Error(`Groq error: ${await res.text()}`);
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  throw new Error(
    'No AI provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.'
  );
}

async function logTurn(args: {
  username: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  signals?: Record<string, string>;
}) {
  try {
    const fields: Record<string, any> = {
      Timestamp: new Date().toISOString(),
      Direction: args.direction === 'inbound' ? 'Inbound' : 'Outbound',
      From: args.direction === 'inbound' ? `ig:${args.username}` : 'BHC AI Closer',
      To: args.direction === 'inbound' ? 'BHC AI Closer' : `ig:${args.username}`,
      Subject: `DM:${args.conversationId}`,
      Body: args.text,
      'Body Plain': args.text,
      'Sender Type':
        args.direction === 'inbound' ? 'Prospect' : 'BHC',
    };
    if (args.signals && Object.keys(args.signals).length) {
      fields['AI Summary'] = JSON.stringify(args.signals);
    }
    await createRecord(TABLES.CONVERSATIONS, fields);
  } catch (e: any) {
    console.error('[manychat webhook] log turn failed:', e?.message);
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  if (!verifyAuth(request.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const subscriberId = String(body.subscriber_id || '').trim();
  const username = String(body.username || body.ig_username || subscriberId)
    .trim()
    .replace(/^@/, '');
  const firstName = String(body.first_name || '').trim();
  const message = String(body.message || body.text || '').trim();
  const source = String(body.source || 'unknown').trim();
  const incomingFields = body.custom_fields || {};
  const incomingTags: string[] = Array.isArray(body.tags) ? body.tags : [];

  if (!subscriberId || !message) {
    return NextResponse.json(
      { error: 'subscriber_id and message required' },
      { status: 400 }
    );
  }

  const conversationId =
    incomingFields.conversation_id || `mc-${subscriberId}`;
  const isFirstContact = !incomingTags.includes('closer_engaged');

  // Fetch history (best-effort; tolerate empty)
  const history = await fetchHistory(conversationId, username);

  // Generate reply
  let reply = '';
  let signals: Record<string, string> = {};
  let aiError: string | null = null;
  try {
    const raw = await callClaudeMultiTurn({
      history,
      newUserMessage: message,
    });
    const parsed = parseClaudeOutput(raw);
    reply = parsed.reply;
    signals = parsed.signals;
  } catch (e: any) {
    aiError = e?.message || 'AI failure';
    console.error('[manychat webhook] AI error:', aiError);
    reply =
      "tied up for a sec — getting ben on this. he'll reply shortly. (you can also book a 30-min call: cal.com/ben-beauchman-1itnsg/30min)";
    signals = { needs_human: 'true', note: 'AI provider error — fallback' };
  }

  // Log inbound + outbound turns (don't await both serially blocking response)
  void logTurn({
    username,
    conversationId,
    direction: 'inbound',
    text: message,
  });
  void logTurn({
    username,
    conversationId,
    direction: 'outbound',
    text: reply,
    signals,
  });

  // Build ManyChat actions: write captured signals to custom fields, tag
  // segment.
  const actions: Array<Record<string, string>> = [
    { action: 'set_field_value', field_name: 'conversation_id', value: conversationId },
    { action: 'add_tag', tag_name: 'closer_engaged' },
    { action: 'add_tag', tag_name: 'ai_replied_once' },
  ];

  const setIf = (field: string, key: string) => {
    const v = (signals[key] || '').trim();
    if (v && v !== 'blank') {
      actions.push({ action: 'set_field_value', field_name: field, value: v });
    }
  };
  setIf('segment', 'segment');
  setIf('intent_signal', 'intent_signal');
  setIf('state', 'state');
  setIf('email', 'email');
  setIf('ranch_name', 'ranch_name');
  if (signals.email && signals.email !== 'blank') {
    actions.push({ action: 'set_field_value', field_name: 'email_captured', value: 'true' });
    actions.push({ action: 'add_tag', tag_name: 'email_captured_tag' });
  }
  // Tag segment (preserve existing taxonomy)
  const segMap: Record<string, string> = {
    'beef-buyer': 'beef-buyer',
    'rancher': 'rancher',
    'merch-buyer': 'merch-buyer',
    'info-seeker': 'info-seeker',
    'supporter': 'supporter',
  };
  if (signals.segment && segMap[signals.segment]) {
    actions.push({ action: 'add_tag', tag_name: segMap[signals.segment] });
  }
  if ((signals.intent_signal || '').toLowerCase() === 'high') {
    actions.push({ action: 'add_tag', tag_name: 'qualified_lead' });
  }

  const needsHuman =
    (signals.needs_human || '').toLowerCase() === 'true' || !!aiError;
  if (needsHuman) {
    actions.push({ action: 'add_tag', tag_name: 'escalate_human' });
    actions.push({ action: 'set_field_value', field_name: 'needs_human', value: 'true' });
  }

  // Telegram alerts
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      if (isFirstContact || needsHuman || (signals.intent_signal || '') === 'high') {
        const flagBits: string[] = [];
        if (isFirstContact) flagBits.push('🆕 first contact');
        if (needsHuman) flagBits.push('🚨 NEEDS HUMAN');
        if ((signals.intent_signal || '') === 'high') flagBits.push('🔥 HIGH INTENT');
        const handle = username ? `@${username}` : `mc:${subscriberId}`;
        const segLine = signals.segment ? `\n<b>Segment:</b> ${signals.segment}` : '';
        const intentLine = signals.intent_signal
          ? `\n<b>Intent:</b> ${signals.intent_signal}`
          : '';
        const stateLine = signals.state ? `\n<b>State:</b> ${signals.state}` : '';
        const emailLine = signals.email ? `\n<b>Email:</b> ${signals.email}` : '';
        const noteLine = signals.note ? `\n<b>Note:</b> ${signals.note}` : '';
        const sourceLine = source !== 'unknown' ? `\n<b>Source:</b> ${source}` : '';
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `📩 <b>IG DM</b> — ${flagBits.join(' · ')}\n\n` +
            `<b>From:</b> ${handle}${firstName ? ` (${firstName})` : ''}` +
            sourceLine +
            segLine +
            intentLine +
            stateLine +
            emailLine +
            noteLine +
            `\n\n<b>Them:</b> ${message}\n\n<b>AI reply:</b> ${reply}`
        );
      }
    }
  } catch (e: any) {
    console.error('[manychat webhook] telegram alert failed:', e?.message);
  }

  // Return ManyChat-shaped response
  return NextResponse.json({
    version: 'v2',
    content: {
      messages: [{ type: 'text', text: reply }],
    },
    actions,
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/webhooks/manychat',
    method: 'POST',
    auth: process.env.MANYCHAT_WEBHOOK_SECRET
      ? 'Bearer token required'
      : 'unset (warn-mode)',
  });
}
