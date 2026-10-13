/**
 * Inbound replies from the bad-debt pool since the last run, and a first guess at
 * what each one means (`replies13.py` + `classify13.py`).
 *
 * The guess is a pointer for the reviewer, not a decision. In run 13 the keyword
 * buckets found 0 of the 7 replies that turned out to be holds, so every reply is
 * listed for a human to read. The buckets that look like a hold are held
 * automatically, which errs toward NOT chasing someone, the safe side.
 */
import type { ContactRow } from "./audience";

export interface InboundMessage {
    channel: "whatsapp" | "email";
    /** Phone digits for WhatsApp, sender address for email. */
    from: string;
    at: string;
    text: string;
}

export interface MatchedReply extends InboundMessage {
    contactId: string;
}

/** WhatsApp's `riivo_from` is keyed by number: digits only, leading 0 → 27. */
export function normaliseFrom(p: string | null | undefined): string {
    const d = (p ?? "").replace(/\D/g, "");
    return d.startsWith("0") ? "27" + d.slice(1) : d;
}

/**
 * Match replies to contacts across the WHOLE pool, not just last run's audience:
 * someone who says stop should be held whichever message reached them, and the
 * daily cadence flow messages these same people.
 */
export function matchReplies(
    messages: readonly InboundMessage[],
    contacts: Iterable<ContactRow>,
): MatchedReply[] {
    const byNumber = new Map<string, Set<string>>();
    const byAddress = new Map<string, Set<string>>();
    for (const c of contacts) {
        const id = c.contactid.toLowerCase();
        for (const raw of [c.mobilephone, c.icon_formattedmobilenumber, c.telephone1]) {
            const n = normaliseFrom(raw);
            if (n.length >= 10) byNumber.set(n, (byNumber.get(n) ?? new Set()).add(id));
        }
        for (const e of [c.emailaddress1, c.emailaddress2, c.emailaddress3]) {
            const a = (e ?? "").trim().toLowerCase();
            if (a) byAddress.set(a, (byAddress.get(a) ?? new Set()).add(id));
        }
    }
    const out: MatchedReply[] = [];
    for (const m of messages) {
        const ids = m.channel === "whatsapp"
            ? byNumber.get(normaliseFrom(m.from))
            : byAddress.get(m.from.trim().toLowerCase());
        for (const contactId of ids ?? []) out.push({ ...m, contactId });
    }
    return out;
}

export type ReplyBucket =
    | "stop / POPIA"
    | "wrong person / dead"
    | "claims already paid"
    | "disputes the debt"
    | "wants arrangement"
    | "promises to pay"
    | "unemployed / hardship"
    | "auto-reply / bot"
    | "asks a question"
    | "acknowledged / other";

const RULES: [ReplyBucket, RegExp][] = [
    ["stop / POPIA", /\bstop sending|do not contact|unsubscribe|remove me|harass|report you|legal action|leave me alone/i],
    ["wrong person / dead", /wrong (person|number|recipient)|not me|no longer (employ|with the company)|emigrated|passed away|deceased|left the compan|never used your service|didn.?t use you/i],
    ["claims already paid", /\b(already|long|has been|was) (paid|settled)|i paid|i have paid|paid (this|it|already|long|with the link|in full)|proof of payment|\bpop\b|payment was made|payment done|double paid|\bi.?ve (now )?paid|it.?s (been )?sorted|sorted (it )?(out )?with/i],
    ["disputes the debt", /don'?t owe|do not owe|dispute|never (received|used|provided)|what (is|for) this|for what is this|no idea what this|incorrect|not my|why (am i|must i)|explain what|get clarity|break this down/i],
    ["wants arrangement", /instal|arrangement|payment plan|pay.{0,14}(off|over).{0,14}month|debt review|per month|p\/m|R\d+ every month|2 installments|give (me )?(un)?t[i]?ll|once all matters/i],
    ["promises to pay", /will (pay|settle|make|sort)|month.?end|end of (the )?month|next (week|month)|on the \d+|by friday|settle on|attend to it/i],
    ["unemployed / hardship", /unemploy|no (job|income)|retrench|cannot afford|can.?t afford|not working/i],
    ["auto-reply / bot", /thank you for contacting|welcome to|automatic reply|out of office|help line|please let (me|us) know how/i],
    ["asks a question", /\?/],
];

/** Buckets that hold the person out of the run unless a reviewer releases them. */
export const AUTO_HOLD_BUCKETS: ReadonlySet<ReplyBucket> = new Set<ReplyBucket>([
    "stop / POPIA", "wrong person / dead", "claims already paid",
    "disputes the debt", "wants arrangement", "unemployed / hardship",
]);

/** Bucket a person by everything they sent, joined, as classify13.py did. */
export function classify(texts: readonly string[]): ReplyBucket {
    const t = texts.join(" || ");
    for (const [name, rx] of RULES) if (rx.test(t)) return name;
    return "acknowledged / other";
}
