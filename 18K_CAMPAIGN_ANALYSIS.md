# 18,000 Recipient Email Campaign - Analysis & Recommendations

## Current Implementation

### How Batches Work
| Setting | Value | Source |
|---------|-------|--------|
| Batch size | **250 recipients** | `campaignBatches.ts` |
| Delay between emails | **1,200ms** | `GRAPH_EMAIL_DELAY_MS` (default) |
| Delay between batches | **3,000ms** | `GRAPH_BATCH_DELAY_MS` (default) |
| Flush interval | Every **25 recipients** | Hard-coded |
| Convex action timeout | **10 minutes** | Platform limit |

### Sending Flow
1. Recipients split into batches of 250
2. **One worker** processes batches sequentially (no parallelism)
3. Within each batch, emails sent one-by-one with a 1,200ms gap
4. After a batch completes, the worker schedules itself for the next batch after 3,000ms
5. Results flushed to DB every 25 recipients (crash recovery)

### Rate Limit Protections
- **Microsoft Graph IncomingBytes limit**: 150 MB per 5-minute rolling window per mailbox
- On **429 (rate limit)**: waits `Retry-After` header or minimum **90 seconds**, retries up to 3 times
- On **5xx**: exponential backoff (1s, 2s, 4s), retries up to 3 times
- On **4xx (non-429)**: fails immediately (no retry)

### Recovery
- Cron job runs every **5 minutes**, detects batches stuck in "processing" for >20 minutes
- Resets stuck batches to "pending" and restarts worker
- Already-sent recipients are skipped on recovery (dedup via `messages` table)

---

## What Happens If We Send 18,000 Emails Now

### Time Estimate

```
18,000 recipients / 250 per batch = 72 batches

Per batch:
  250 emails x 1.2s delay = 300 seconds (5 minutes)
  + ~50s overhead (Graph API round-trips, DB flushes, attachment resolution)
  + 3s inter-batch delay
  ≈ 353 seconds per batch

Total: 72 batches x 353s = 25,416 seconds ≈ 7.1 hours
```

**At current settings, this campaign will take approximately 7 hours.**

### Rate Limit Risk

Each email payload (HTML + headers) is typically 20-100 KB. Assuming ~50 KB average:

```
Emails per 5-min window:  5 min / 1.2s = ~250 emails
Data per 5-min window:    250 x 50 KB = ~12.5 MB
Graph limit:              150 MB / 5 min
Usage:                    ~8% of limit
```

**Rate limit risk is LOW** at current settings. We're using only ~8% of the IncomingBytes budget. The 1,200ms delay is very conservative.

### Convex Action Timeout Risk

Each batch takes ~5-6 minutes. Convex actions timeout at **10 minutes**. This is safe but leaves limited headroom. If Graph API responds slowly or retries kick in, a batch could approach the timeout.

---

## CRITICAL: Inline Image Impact (5-10 images per email)

The calculations above assumed ~50 KB per email. But campaigns include 5-10 inline images
attached as base64 CID attachments. This changes everything:

```
5 images x 200 KB average = 1 MB per image set
Base64 overhead (+33%):    ~1.33 MB per email

At 1200ms delay (current default):
  Emails per 5-min window:  250
  Data per 5-min window:    250 x 1.33 MB = 333 MB
  Graph limit:              150 MB / 5 min
  Usage:                    222% ← OVER LIMIT, will trigger 429s

At 200ms delay:
  Emails per 5-min window:  1,500
  Data per 5-min window:    1,500 x 1.33 MB = 2,000 MB
  Usage:                    1,333% ← MASSIVELY OVER LIMIT
```

### Fix Implemented: Host Images as URLs

Instead of attaching images as base64 in every email, we now:
1. Upload inline images to Convex storage during campaign creation
2. Serve them via a public `/image?id=<storageId>` HTTP endpoint
3. Replace `<img src="cid:...">` with `<img src="https://your-site.convex.site/image?id=...">`

**Result:** Email payload drops from ~1.33 MB to ~20-50 KB (just HTML + tracking headers).

```
At 200ms delay (with URL-hosted images):
  Emails per 5-min window:  1,500
  Data per 5-min window:    1,500 x 50 KB = 75 MB
  Graph limit:              150 MB / 5 min
  Usage:                    50% ← safe
```

---

## Recommendations to Send 18K in ~1-2 Hours

### Option 1: Reduce Email Delay (Simplest - env var change only)

Lower `GRAPH_EMAIL_DELAY_MS` from 1,200ms to **200ms**:

```
Per batch: 250 x 0.2s = 50s + ~50s overhead ≈ 100s
72 batches x 100s = 7,200s ≈ 2 hours
```

**Rate limit check at 200ms:**
```
Emails per 5 min:  5 min / 0.2s = 1,500 emails
Data per 5 min:    1,500 x 50 KB = 75 MB
Graph limit:       150 MB / 5 min
Usage:             50% of limit ← safe
```

**How to apply:** Set `GRAPH_EMAIL_DELAY_MS=200` in your Convex environment variables. No code deploy needed.

### Option 2: Reduce Delay + Increase Batch Size (Code change)

Set `GRAPH_EMAIL_DELAY_MS=200` AND increase batch size from 250 to 500:

```
36 batches x ~150s = 5,400s ≈ 1.5 hours
```

This reduces overhead from batch transitions and DB operations. Rate limit usage stays at ~50%.

**Risk:** Batches take longer (~2.5 min each), but still well under the 10-min Convex action timeout.

### Option 3: Parallel Workers Across Multiple Mailboxes (Code change - most complex)

If you have multiple shared mailboxes, you could run one worker per mailbox in parallel. Each mailbox has its own 150 MB/5-min budget.

- 2 mailboxes = ~1 hour
- 3 mailboxes = ~40 minutes

This requires code changes to distribute recipients across mailboxes and run concurrent workers.

---

## Recommendation

**Go with Option 1 for this campaign.** Just change the environment variable:

```
GRAPH_EMAIL_DELAY_MS=200
```

This gets you from ~7 hours down to ~2 hours with zero code changes and stays well within Graph API limits (50% of budget). You can change it back after the campaign if you want to be conservative for smaller sends.

If 2 hours is still too slow, add Option 2 (increase batch size to 500) which brings it to ~1.5 hours with a small code change.

---

## Risk Summary

| Risk | At 1200ms (current) | At 200ms (recommended) |
|------|---------------------|----------------------|
| Graph IncomingBytes | ~8% of limit | ~50% of limit |
| 429 rate limit | Very unlikely | Unlikely |
| Convex action timeout | Safe (~5 min/batch) | Safe (~2 min/batch) |
| Duplicate sends | Protected (dedup) | Protected (dedup) |
| Partial failure recovery | Flush every 25 | Flush every 25 |

### What to Monitor During Send
1. **Convex dashboard** - watch for 429 errors in function logs
2. **Campaign progress page** - sent/failed counts updating
3. If you see 429s, increase the delay back up via `GRAPH_EMAIL_DELAY_MS`
