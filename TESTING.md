# Testing the Tag & Consent Auditor

You need a laptop with Google Chrome. Allow about 20 minutes for all three parts.

```
tag-consent-auditor/
├── extension/        ← the extension itself (this is what Chrome loads)
├── test-pages/       ← two practice sites: one set up well, one badly
├── automated-test/   ← optional script that runs the checks for you
├── README.md         ← what the extension does
└── TESTING.md        ← this file
```

---

## Part 1 · Install the extension (2 minutes)

1. Unzip `tag-consent-auditor.zip` somewhere you'll keep it, e.g. your Documents folder.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked** and choose the **`extension`** folder (not the outer folder).
5. Click the puzzle-piece icon in Chrome's toolbar and **pin** "Tag & Consent Auditor".
6. On the extension's card, click **Details** and turn on **Allow in Incognito**. You'll need this for clean tests.

After any update: replace the `extension` folder, click the **reload arrow** on the extension's card, then refresh the website you're testing.

---

## Part 2 · Check it against the practice sites (5 minutes)

These pages pretend to load Google, Meta and LinkedIn tags with fake IDs, so you know exactly what the extension should find.

1. Open **Terminal** (Mac) and run, swapping in where you unzipped it:
   ```
   cd ~/Documents/tag-consent-auditor/test-pages
   python3 -m http.server 8765
   ```
   Leave this window open while you test. (It has to be served this way; opening the file directly doesn't allow cookies.)
2. In Chrome, open an **Incognito** window.
3. **Bad site:** go to `http://localhost:8765/bad.html`, wait 2 seconds, click the extension icon.
   You should see a score of **18** and **3 critical issues**:
   - Consent default set after Google tags loaded
   - 3 tracking cookies set before consent
   - Ad pixels fire before consent
   
   …plus warnings for 2 GTM containers, a duplicate GA4 page_view, missing Consent Mode v2 signals and missing Enhanced Conversions.
4. **Good site:** close the Incognito window, open a new one, go to `http://localhost:8765/good.html`.
   - Before clicking anything: Consent tab shows everything **denied**.
   - Click **Accept**, then **Submit lead**, then open the extension.
   - You should see a score of **100**, "Looking healthy", and in the Consent tab every signal going **denied → granted**.
5. Try the **moon/sun** button (dark mode), **Copy report** (paste it somewhere to check), and each tab.

If any of these don't match, screenshot the popup and send it to me.

> The practice pages send dummy requests to Google, Meta and LinkedIn with fake IDs. They don't reach any real account.

---

## Part 3 · Test on real websites (10–15 minutes)

This is the important part: real sites are messier than the practice pages.

**For each site, do this in a fresh Incognito window:**

1. Open the site, **don't touch the cookie banner**, open the extension. Note the score and issues.
2. **Accept** the banner, wait a few seconds, check again. The Consent tab should show signals changing to granted, and new cookies should appear *after* the choice.
3. In another fresh Incognito window, repeat with **Reject**. Ad pixels firing after rejecting is a real finding.
4. If the site has a form or checkout, submit a test form and check the **Timeline** tab for the conversion event.

**Good sites to try** (a mix of setups):
- A large UK/EU e-commerce site (usually GTM + GA4 + Google Ads + Meta + a CMP)
- A B2B SaaS site with a "Book a demo" form (often LinkedIn + HubSpot)
- A small business or local shop site (often no consent setup at all)
- A US site (often no consent banner, so expect consent warnings)
- Your own site, matveylutsenko.com (should show almost nothing, which is correct)

**Optional cross-check:** run Google Tag Assistant on the same page. The tag IDs and events it shows should match the extension's **Tags** tab.

**What to send me** for anything that looks wrong:
- the site's address,
- what you did (opened / accepted / rejected / submitted a form),
- a screenshot of the popup, and what you expected instead.

Common things worth reporting: a tag you know is there but isn't listed, a "critical" issue that's actually fine, or a score that feels unfair.

---

## Optional · Automated test (for developers)

Runs Part 2 automatically and prints every finding.

```
pip install playwright
playwright install chromium
# terminal 1
cd test-pages && python3 -m http.server 8765
# terminal 2
cd automated-test && python3 run_test.py
```

Expected: `good.html  score 100` and `bad.html  score 18`.

## Known limits

- Cookies marked HttpOnly can't be seen, so a few server-set cookies won't appear.
- Right after installing or reloading the extension, refresh the website: the first page load can miss a tag.
- Checks follow public documentation and common practice. Treat the score as a quick health check, not a legal compliance review.
