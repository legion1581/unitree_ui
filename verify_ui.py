import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.goto('http://localhost:5173')

        # Click connect in app
        await page.click('button:has-text("Connect")')

        # Wait for dialog and select Custom
        await page.wait_for_selector('select')
        await page.select_option('select', 'CUSTOM')

        # Take screenshot of the connection panel
        await page.screenshot(path='/home/jules/verification/verification2.png')
        await browser.close()

asyncio.run(main())
