# Email Template Design — Research & Feature Gap Analysis

> Research on HTML email design standards and SOTA email-builder feature sets, mapped against our tool's current editor. Goal: decide what to build to bring template creation up to standard and improve the design UX.
> Date: 2026-06-23

---

## 1. Where we are today

Our editor (`src/components/email/EmailComposer.tsx`) is a lightweight, custom `contenteditable` + `document.execCommand()` WYSIWYG. Templates are stored as **raw HTML** in the `emailTemplates` Convex table.

**What works today:** bold/italic/underline, H1/H2, font family + size, text alignment, bullet/numbered lists, links, image upload (with client-side compression), and three merge fields (`{firstName}`, `{fullName}`, `{email}`).

**What's missing (the reason this doc exists):**
- No color picker (text or background)
- No **CTA / button** builder
- No **gradients** or background colors/images on sections
- No layout/columns system — everything is one linear flow
- No pre-built blocks/sections (header, hero, footer, divider, spacer)
- No borders, shadows, or spacing controls
- No dark-mode awareness
- No structured document model — raw HTML only, so we can't reason about or re-flow content

This is the core problem: `contenteditable` produces inconsistent, browser-flavored HTML (often `<div>`/`<span>` soup) that does **not** render reliably across email clients. Email is not the web — see §3.

---

## 2. What SOTA email builders offer

Surveyed: **Stripo**, **Beefree (BEE)**, **Mailchimp**, **Unlayer**, **Chamaileon**, plus the dev-focused frameworks **MJML**, **Maizzle**, and **React Email**.

The market splits into two camps, and the best products do both:

### A. Block / drag-and-drop builders (the UX standard)
The dominant paradigm. Users assemble emails from **structured content blocks** dropped into **rows of columns**, never touching HTML.

Common feature set across Stripo / Beefree / Mailchimp / Unlayer:
- **Drag-and-drop block editor** with a structured (JSON) document model
- **Row/column layouts** (1-col, 2-col, 3-col, mixed) that auto-stack on mobile
- **Content block library**: text, image, **button/CTA**, divider, spacer, social icons, video, HTML, menu/nav, and dynamic blocks (countdown timer, image carousel)
- **Reusable saved modules** — save a block/section and reuse it across emails (Stripo's "modules", Beefree "saved rows")
- **Template gallery** — Stripo ships 1,650+ templates; Beefree 500k+ stock images
- **Per-element styling panel**: colors, **gradients**, background images, padding/margin, borders, border-radius, shadows, alignment
- **Mobile preview + per-device overrides**
- **Brand kit / design tokens** — saved palette, fonts, logo applied consistently
- **AMP / interactive + dynamic personalization (merge tags)**
- **Collaboration**: roles, version history, comments
- **Export** to HTML and to multiple ESPs

### B. Code frameworks (the rendering engine standard)
MJML and Maizzle solve the *output* problem. You author in a high-level syntax (`<mj-section>`, `<mj-column>`, `<mj-button>`) and the compiler emits bulletproof, table-based, cross-client HTML — no hand-nesting tables.

- **MJML**: semantic component tags → responsive, Outlook-safe HTML. Trade-off: verbose output that can approach Gmail's 102KB clip limit.
- **Maizzle**: Tailwind-based, with automatic CSS inlining and minification — smaller output, more control.
- **React Email**: component-driven (JSX), good for transactional emails in React/Next stacks (which we are).

**Key insight for us:** the winning architecture is **block editor on top, compiler underneath** — users edit a structured document; we *generate* bulletproof HTML from it rather than letting `contenteditable` emit whatever the browser produces.

---

## 3. Email rendering reality (the constraints that drive every decision)

Email is **not** modern web. These are hard constraints, not preferences:

- **No Flexbox/Grid.** Outlook (desktop) renders with the MS Word engine. Layout must use `<table>`. Safe content width: **600–700px**.
- **CSS must be inlined.** Many clients strip `<style>` blocks; styles belong on the element.
- **Gmail clips at ~102KB** of HTML. Past that, recipients see "Message clipped" and may miss the CTA. Keep output lean.
- **Gradients are fragile.** They work in Apple Mail / iOS / modern Outlook, but **Gmail (esp. Android) mangles background gradients/images on text**, sometimes inverting text to white and making it illegible. Rule: gradients are decorative only — never put critical text on a raw gradient; bake text into an image or provide a solid fallback color.
- **Dark mode is inconsistent.** Apple Mail, iOS, Outlook 2019+, Samsung, Thunderbird honor `prefers-color-scheme`. Gmail and Outlook **mobile apps aggressively invert colors** with no opt-out. Use `rgba()` backgrounds on buttons to resist inversion.
- **Always test in real clients** (Litmus / Email on Acid). Previews lie.

### Bulletproof CTA buttons (since the user called these out)
A real email button is **not** a styled `<div>`. The robust pattern:
- Background color on the **table cell** (`<td>`), not the link — Outlook ignores bg on inline elements.
- Link fills the cell with padding so the **whole button is clickable**.
- **VML conditional** (`<!--[if mso]>`) gives Outlook rounded corners and proper sizing.
- **Touch target ≥ 44×44px** (Litmus recommends 42–72px height); padding ~12–16px vertical / 24–32px horizontal.
- CTA copy: 1–5 words.
- Use `rgba()` background to survive dark-mode inversion.

Litmus recommends the **conditional-padding** approach as the best default. This is exactly the kind of thing users should get for free from a button block — not hand-code.

---

## 4. Accessibility (now also deliverability)

2026 spam filters at Gmail/Yahoo/Apple factor in accessibility. It is no longer optional:
- Meaningful **alt text** on every image
- Sufficient **color contrast** (WCAG AA: 4.5:1 for text)
- **Semantic structure** + logical reading order
- Real text over text-in-images where possible (with the gradient exception above)
- `role="presentation"` on layout tables
- `lang` attribute and a descriptive preheader

---

## 5. Recommended feature roadmap

Mapped to effort. The strategic decision in §6 gates everything below it.

### Tier 1 — High impact, fits current architecture
1. **Bulletproof CTA button block** — insert dialog (label, URL, bg color, text color, radius, alignment, full-width toggle) that generates table-based, VML-safe HTML. *Directly addresses the user's ask.*
2. **Color pickers** — text color + highlight/background color. Provide a brand palette (design tokens) plus custom hex.
3. **Background color on sections** — solid backgrounds for content blocks and the email body/canvas.
4. **Divider & spacer blocks** — trivial, high-use.
5. **Alt text field on images** — accessibility + deliverability.
6. **Link-color & button styling** consistency.

### Tier 2 — Layout & reuse
7. **Multi-column rows** (1/2/3-col) that auto-stack on mobile — the single biggest layout gap.
8. **Pre-built sections / blocks** — header (logo), hero, footer (unsubscribe/address), social row.
9. **Saved/reusable modules** — let users save and re-drop sections.
10. **Gradient support** — as a *decorative* background option with mandatory solid fallback and a dark-mode warning; never under body text.
11. **Spacing & border controls** — padding/margin, border, border-radius.

### Tier 3 — Polish & scale
12. **Mobile preview toggle** (we have desktop/mobile preview already — extend with per-device overrides).
13. **Dark-mode preview + safe defaults** (`rgba()` buttons, color-scheme meta).
14. **Brand kit** — saved palette, fonts, logo as design tokens.
15. **Template gallery** — starter templates.
16. **Litmus/Email-on-Acid integration** for real-client testing.
17. **Dynamic/personalization** — expand merge fields beyond the current three.

---

## 6. The architectural decision

The biggest question is **whether to keep raw `contenteditable` HTML or move to a structured document model + compiler.**

- **Keep contenteditable, bolt on features (Tier 1):** fastest path to the user's immediate ask (buttons, colors, gradients). But every new block fights the browser's HTML output, cross-client rendering stays unreliable, and we can't do columns/mobile-stacking robustly. This is a ceiling.
- **Adopt a structured model + email compiler (MJML / Maizzle / React Email):** users edit blocks; we generate bulletproof HTML. This is how every SOTA builder works and the only way to get reliable cross-client + responsive + dark-mode output. Bigger lift, and we'd migrate existing raw-HTML templates. Given our stack is **Next.js + React 19**, **React Email** or **MJML** are the natural fits.

**Recommendation:** ship the **Tier 1 button + color blocks now** on the current editor (immediate value, low risk), but **plan the migration to a structured block model with an MJML/React-Email compiler** as the real fix — because columns, responsiveness, dark mode, and bulletproof output are not achievable reliably on `contenteditable`. Treat Tier 1 as a stopgap, not the destination.

---

## Sources

- [HTML Email Best Practices 2026 — Markaplugin](https://markaplugin.com/blog/html-email-best-practices-2026)
- [Bulletproof Email Buttons — Litmus](https://www.litmus.com/blog/a-guide-to-bulletproof-buttons-in-email-design)
- [Email Design Size Guide 2026 — Digital Applied](https://www.digitalapplied.com/blog/email-design-size-guide-2026-templates)
- [HTML Email Design Best Practices: 10 Golden Rules — Listrak](https://www.listrak.com/blog/html-email-design-best-practices-the-10-golden-rules)
- [Bulletproof Email Buttons HTML/CSS/VML — ActiveCampaign](https://www.activecampaign.com/blog/email-buttons)
- [21 Best HTML Email Builders 2026 — Sequenzy](https://www.sequenzy.com/blog/best-html-email-builders)
- [Stripo Drag & Drop Builder — Mailchimp](https://mailchimp.com/integrations/stripo/)
- [16 Best Drag-and-Drop Email Builders 2026 — TheCMO](https://thecmo.com/tools/best-drag-and-drop-email-builder/)
- [Ultimate Guide to Dark Mode for Email — Litmus](https://www.litmus.com/blog/the-ultimate-guide-to-dark-mode-for-email-marketers)
- [Dark Mode Email Design Without Breaking Outlook — Markaplugin](https://markaplugin.com/blog/dark-mode-email-design)
- [Complete Guide to Email Client Rendering Differences 2026 — DEV](https://dev.to/mailpeek/the-complete-guide-to-email-client-rendering-differences-in-2026-243f)
- [MJML — The Responsive Email Framework](https://mjml.io/)
- [Why MJML & Maizzle Are the Future of Email Dev — EmailMavlers](https://emailmavlers.com/blog/mjml-maizzle-vs-raw-html/)
- [React Email vs MJML vs Maizzle 2026 — BuildPilot](https://trybuildpilot.com/688-react-email-vs-mjml-vs-maizzle-2026)
- [The Pros and Cons of MJML 2026 — Scalero](https://scalero.io/company/blog/the-pros-and-cons-of-mjml)
