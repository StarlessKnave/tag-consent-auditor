# Tag & Consent Auditor

A Chrome extension that audits a website's measurement setup while you browse it.

Open any page, click the extension, and it shows:

- **Which tags are on the page and whether they actually fire.** Covers Google Tag Manager, GA4 (including server-side endpoints), Google Ads, Meta, LinkedIn, Microsoft UET, TikTok, HubSpot, Hotjar and Clarity.
- **How Consent Mode behaves.** Default and updated states for all four v2 signals, whether the default is set before Google tags load, and Advanced vs Basic mode.
- **What happens before consent.** Tracking cookies and ad pixels that fire before the visitor accepts.
- **Conversion tracking.** Key events such as `generate_lead` and `purchase`, duplicate page views, and whether Enhanced Conversions data is attached.
- **A score and a plain-English report** with a suggested fix for every issue, which you can copy in one click.

Everything runs locally in your browser. The extension only observes; it never changes what a page sends, and no data leaves your machine.

## Install (developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Pin the extension, open any website and click the icon.

Tip: reload the page after installing, accept or reject the cookie banner, and submit a test form to see the full picture.

Full testing steps: see [TESTING.md](TESTING.md).

## How it works

- `extension/inject-main.js` runs in the page and watches `dataLayer` pushes (including `gtag('consent', …)` commands) and cookies as they appear.
- `extension/background.js` watches network requests and classifies them by vendor, tag ID, event name and consent state (`gcs`).
- `extension/analyze.js` turns those observations into checks, a score and a timeline.
- `extension/popup.html` / `popup.js` show the results live.

## Limitations

- HttpOnly cookies aren't visible to page scripts, so they don't appear in the cookie list.
- Checks are based on public documentation and common best practice. They are a quick health check, not a legal compliance review.

Built by [Matvey Lutsenko](https://matveylutsenko.com).

## License

MIT. See [LICENSE](LICENSE).
