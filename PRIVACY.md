# Privacy Policy: Tag & Consent Auditor

_Last updated: 10 November 2026_

Tag & Consent Auditor is a Chrome extension that audits the analytics, advertising and consent setup of the web page you are viewing. This policy explains what the extension does with data.

## Summary

**The extension does not collect, store on any server, sell or share any data.** Everything it does happens locally in your browser. The developer receives nothing.

## What the extension reads, and why

To audit a page, the extension observes, on your device only:

- **Network requests the page sends to analytics and advertising services** (for example Google Analytics, Google Ads, Meta, LinkedIn and Microsoft), to work out which tags fire, with which IDs and events, and whether consent was given at the time.
- **The page's `dataLayer` and consent commands**, to see how Google Consent Mode is set up.
- **The names of cookies the page sets** (not their values), to spot tracking cookies set before consent.

The extension only observes. It never changes, blocks or adds to what the page sends.

## What is stored, where, and for how long

- **Audit results for each open tab** are kept in Chrome's session storage on your device so they survive while the extension's background process is idle. They are deleted when you close the tab and cleared when you close the browser.
- **Your light or dark mode choice** is saved in the extension's local storage on your device.

Nothing is synced to your Google account, and nothing is sent to the developer or any third party.

## Copying a report

When you click **Copy report**, a plain-text summary is copied to your clipboard. Where it goes from there is up to you.

## Permissions

The extension asks for access to all websites, plus the `webRequest`, `webNavigation`, `storage` and `tabs` permissions. They are used only for the audit described above, and only on your device.

## Third parties

The extension contains no analytics, advertising, tracking or remote code of its own, and makes no network requests of its own.

## Changes to this policy

If the extension's data handling ever changes, this policy will be updated and the date above revised.

## Contact

Questions about this policy: open an issue at [github.com/StarlessKnave/Tag-Auditor-](https://github.com/StarlessKnave/Tag-Auditor-/issues) or get in touch through [matveylutsenko.com](https://matveylutsenko.com).
