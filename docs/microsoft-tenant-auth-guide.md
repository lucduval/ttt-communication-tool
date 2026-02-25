# Microsoft Tenant Authentication Guide

## Error Analysis: WhoAmI 502 Bad Gateway

### The Error

```
Uncaught Error: WhoAmI probe failed (502):
<title>502 - Web server received an invalid response while acting as a gateway or proxy server.</title>
```

### What Happened

The `WhoAmI` call is a standard Dynamics 365 health-check endpoint (`GET /api/data/v9.2/WhoAmI()`). It validates that the access token is valid and the caller has access to the Dynamics environment. The other project uses this as a connectivity probe before syncing data.

A **502 Bad Gateway** means the request successfully left the caller, reached the Azure infrastructure (IIS reverse proxy) in front of Dynamics 365, but the proxy could not get a valid response from the backend Dynamics application server. Critically, the response body is an **IIS HTML error page**, not a JSON payload — this confirms the failure is at the infrastructure/gateway layer, not at the Dynamics application layer.

### Root Causes (Most to Least Likely)

| Cause | Explanation |
|---|---|
| **Transient Dynamics outage** | Dynamics 365 online environments occasionally become briefly unreachable during internal scaling, failover, or maintenance windows. A single 502 is common and expected. |
| **Rate/concurrency throttling at infrastructure level** | Dynamics enforces concurrency and API rate limits. If the service principal is shared across multiple projects hitting the same org simultaneously, the gateway may reject overflow requests with 502. |
| **Dynamics environment maintenance** | Microsoft schedules weekly maintenance for Dynamics environments. During those windows, APIs can return 502/503. |
| **Token scope mismatch** | If `DYNAMICS_ORG_URL` is slightly different between projects (e.g. trailing slash, `.crm.dynamics.com` vs `.crm6.dynamics.com`), the token scope won't match and the gateway may reject the request before it reaches the app. |
| **Service principal permissions** | The app registration may not have the required Application permissions (`user_impersonation` or Dynamics CRM `Full Access`) granted for the new project's client ID, or admin consent is missing. |

### Why This Project Doesn't Hit This Error (Often)

This project has several protections that the new project is likely missing:

1. **Retry logic with exponential backoff** — 502 is explicitly listed as retryable
2. **Token caching with expiry buffer** — avoids redundant token requests
3. **No WhoAmI probe** — calls go directly to the needed endpoints, so a transient 502 is retried on the real call rather than failing on a pre-flight check

---

## How This Project Authenticates to the Microsoft Tenant

### Overview

This project uses two separate **OAuth 2.0 Client Credentials** flows (service principal / app-only) to authenticate as an application (not a user) against the same Azure AD tenant:

1. **Dynamics 365 Web API** — for CRM data (contacts, activities, entities)
2. **Microsoft Graph API** — for sending emails from shared mailboxes

Both use the same Azure AD tenant (`AZURE_TENANT_ID`) but can use different app registrations.

### Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                   Convex Backend                      │
│                                                       │
│  ┌─────────────────┐       ┌──────────────────────┐  │
│  │ dynamics_auth.ts │       │   graph_client.ts     │  │
│  │                  │       │                       │  │
│  │ Client Creds     │       │ Client Creds          │  │
│  │ AZURE_CLIENT_ID  │       │ GRAPH_CLIENT_ID       │  │
│  │ AZURE_CLIENT_    │       │ GRAPH_CLIENT_SECRET   │  │
│  │   SECRET         │       │ (falls back to        │  │
│  │                  │       │  AZURE_CLIENT_*)      │  │
│  └──────┬───────────┘       └──────────┬────────────┘  │
│         │                              │               │
└─────────┼──────────────────────────────┼───────────────┘
          │                              │
          ▼                              ▼
┌───────────────────┐         ┌───────────────────────┐
│  Azure AD Token   │         │   Azure AD Token      │
│  Endpoint         │         │   Endpoint            │
│  (same tenant)    │         │   (same tenant)       │
│                   │         │                       │
│  Scope:           │         │  Scope:               │
│  {DYNAMICS_ORG_   │         │  https://graph.       │
│   URL}/.default   │         │  microsoft.com/       │
│                   │         │  .default             │
└────────┬──────────┘         └──────────┬────────────┘
         │                               │
         ▼                               ▼
┌───────────────────┐         ┌───────────────────────┐
│  Dynamics 365     │         │   Microsoft Graph     │
│  Web API v9.2     │         │   v1.0                │
│                   │         │                       │
│  Contacts, users, │         │   Send mail, mailbox  │
│  activities, etc. │         │   access, bounces     │
└───────────────────┘         └───────────────────────┘
```

### Dynamics 365 Authentication (`dynamics_auth.ts`)

**Flow:** OAuth 2.0 Client Credentials Grant

**Token acquisition:**
```
POST https://login.microsoftonline.com/{AZURE_TENANT_ID}/oauth2/v2.0/token

client_id     = AZURE_CLIENT_ID
client_secret = AZURE_CLIENT_SECRET
scope         = {DYNAMICS_ORG_URL}/.default
grant_type    = client_credentials
```

**Key details:**
- Token is cached in-memory with a 5-minute expiry buffer (re-fetched when less than 5 minutes remain)
- All API calls go to `{DYNAMICS_ORG_URL}/api/data/v9.2/{endpoint}`
- Requests include OData v4.0 headers and annotation preferences
- No built-in retry at the `dynamicsRequest()` level — retries are handled by callers

**Required Azure AD app registration permissions:**
- Dynamics CRM `user_impersonation` (Application permission, admin-consented)
- The service principal must be added as an Application User in Dynamics with the appropriate Security Role

### Microsoft Graph Authentication (`graph_client.ts`)

**Flow:** OAuth 2.0 Client Credentials Grant

**Token acquisition:**
```
POST https://login.microsoftonline.com/{AZURE_TENANT_ID}/oauth2/v2.0/token

client_id     = GRAPH_CLIENT_ID (or AZURE_CLIENT_ID)
client_secret = GRAPH_CLIENT_SECRET (or AZURE_CLIENT_SECRET)
scope         = https://graph.microsoft.com/.default
grant_type    = client_credentials
```

**Key details:**
- Separate env vars (`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`) allow using a different app registration than Dynamics, with fallback to `AZURE_CLIENT_*`
- Token is cached in-memory with a 5-minute expiry buffer
- Email sending includes built-in retry: 3 attempts with exponential backoff (1s, 2s, 4s)
- Only retries on status codes defined in `retry.ts`: 429, 500, 502, 503, 504

**Required Azure AD app registration permissions:**
- `Mail.Send` (Application permission, admin-consented)
- `Mail.ReadWrite` (Application permission for bounce processing)

### Environment Variables Reference

| Variable | Used By | Purpose |
|---|---|---|
| `AZURE_TENANT_ID` | Both | Azure AD tenant identifier |
| `AZURE_CLIENT_ID` | Dynamics (primary), Graph (fallback) | App registration client ID |
| `AZURE_CLIENT_SECRET` | Dynamics (primary), Graph (fallback) | App registration client secret |
| `GRAPH_CLIENT_ID` | Graph (preferred) | Dedicated Graph app registration |
| `GRAPH_CLIENT_SECRET` | Graph (preferred) | Dedicated Graph app secret |
| `DYNAMICS_ORG_URL` | Dynamics | e.g. `https://orgname.crm.dynamics.com` |
| `SHARED_MAILBOX_ADDRESS` | Graph | Default shared mailbox for email sending |
| `SHARED_MAILBOX_ADDRESSES` | Graph | Comma-separated list of available mailboxes |

---

## Recommendations for the New Project

### 1. Add Retry Logic with Exponential Backoff (Critical)

The 502 error was **uncaught** — the new project should never let a single transient failure crash a sync. Implement retry logic modeled on this project's `retry.ts`:

```typescript
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
```

Apply this to **every** Dynamics API call, including the WhoAmI probe.

### 2. Make the WhoAmI Probe Resilient

If the new project uses a WhoAmI call to verify connectivity, wrap it in retry logic. Better yet, consider making it optional — this project skips the probe entirely and goes straight to the needed API calls. If the token is invalid, the real call will fail with a clear 401.

```typescript
async function verifyDynamicsConnection(): Promise<boolean> {
  try {
    await withRetry(async () => {
      const res = await fetch(`${dynamicsUrl}/api/data/v9.2/WhoAmI()`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        if (RETRYABLE_STATUS.includes(res.status)) {
          throw new Error(`WhoAmI returned ${res.status}`);
        }
        throw new Error(`WhoAmI failed permanently: ${res.status} - ${text}`);
      }
    }, 3, 2000);
    return true;
  } catch {
    return false;
  }
}
```

### 3. Parse Non-JSON Error Responses

The 502 returned HTML, not JSON. API wrapper code should handle this gracefully:

```typescript
async function parseErrorResponse(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.error?.message || JSON.stringify(json);
  } catch {
    // Strip HTML tags for logging — response is an IIS error page
    return text.replace(/<[^>]*>/g, "").trim().substring(0, 500);
  }
}
```

### 4. Token Caching

Always cache tokens with an expiry buffer. This project uses a 5-minute buffer, meaning it re-fetches the token when less than 5 minutes of validity remain. This avoids:
- Unnecessary token requests that could be rate-limited
- Using an expired token that triggers a 401 cascade

### 5. Use Separate App Registrations Per Service

This project supports separate app registrations for Graph and Dynamics. For the new project, consider doing the same:
- A Dynamics-only app registration with just Dynamics CRM permissions
- A Graph-only app registration with just Mail/Calendar permissions
- This limits blast radius if a secret is compromised, and avoids shared rate limit quotas

### 6. Validate the `DYNAMICS_ORG_URL` Format

Ensure the URL exactly matches the Dynamics environment:
- Include the scheme: `https://orgname.crm.dynamics.com`
- No trailing slash
- Correct regional suffix (`.crm.dynamics.com`, `.crm4.dynamics.com`, `.crm6.dynamics.com`, etc.)
- The scope in the token request must be `{DYNAMICS_ORG_URL}/.default` — a mismatched URL means the token won't be accepted

### 7. Handle Dynamics Maintenance Windows

Dynamics 365 online has scheduled maintenance (usually weekly). During those windows, APIs may return 502/503 intermittently. Options:
- Retry with longer backoff (up to 60 seconds between retries)
- Implement a circuit breaker that pauses sync for a few minutes after repeated 502s
- Log maintenance-window errors at `warn` level instead of `error` to reduce alert noise

### 8. Rate Limit Awareness

If both projects share the same app registration and hit the same Dynamics org, they share API rate limits (Dynamics enforces per-org, per-user/principal limits). Consider:
- Using different service principals per project
- Implementing request queuing/throttling
- Respecting `Retry-After` headers on 429 responses

---

## Quick Diagnostic Checklist for 502 Errors

- [ ] Is the `DYNAMICS_ORG_URL` correct and reachable from a browser?
- [ ] Is the service principal registered as an Application User in Dynamics?
- [ ] Does the app registration have Dynamics CRM permissions with admin consent?
- [ ] Is the Dynamics environment currently under maintenance? (Check [Microsoft 365 Service Health](https://admin.microsoft.com/Adminportal/Home#/servicehealth))
- [ ] Are multiple projects/services hitting the same org with the same principal? (Rate limit risk)
- [ ] Does the code retry on 502, or does it fail immediately? (Most likely cause of this specific error)
- [ ] Is the token scope exactly `{DYNAMICS_ORG_URL}/.default`?
