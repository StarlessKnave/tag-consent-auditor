"""Automated check: loads the extension in Chromium, opens both test pages,
and prints the score and every finding.

Setup (once):  pip install playwright && playwright install chromium
Run:           1) in test-pages/:      python3 -m http.server 8765
               2) in automated-test/:  python3 run_test.py

Expected: good.html scores 100, bad.html scores 18 with 3 critical issues.
Screenshots of the popup are saved next to this script.
"""
import asyncio, os, shutil, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
BASE = "http://localhost:8765"


async def main():
    profile = tempfile.mkdtemp()
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            profile, headless=False,
            args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            viewport={"width": 900, "height": 700})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]

        for name in ["good", "bad"]:
            await ctx.clear_cookies()  # each test page starts like a first visit
            page = await ctx.new_page()
            await page.goto(f"{BASE}/{name}.html")
            await page.wait_for_timeout(2000)
            if name == "good":  # accept consent, then submit a lead
                await page.click("#acc"); await page.wait_for_timeout(700)
                await page.click("#lead"); await page.wait_for_timeout(1200)

            popup = await ctx.new_page()
            await popup.goto(f"chrome-extension://{ext_id}/popup.html")
            tab_id = await popup.evaluate(f"chrome.tabs.query({{url:'{BASE}/{name}.html'}}).then(t => t[0].id)")
            await popup.set_viewport_size({"width": 420, "height": 600})
            await popup.goto(f"chrome-extension://{ext_id}/popup.html?tabId={tab_id}")
            await popup.wait_for_timeout(1500)
            await popup.screenshot(path=os.path.join(HERE, f"{name}-popup.png"))

            result = await popup.evaluate(f"chrome.runtime.sendMessage({{kind:'getState', tabId:{tab_id}}}).then(s => analyze(s))")
            print(f"\n{name}.html  score {result['score']}")
            for c in result["checks"]:
                print(f"  {c['sev'].upper():5} {c['title']}")
        await ctx.close()
    shutil.rmtree(profile, ignore_errors=True)


asyncio.run(main())
