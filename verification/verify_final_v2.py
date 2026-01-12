
from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()

    # Mock everything
    page.route("**/api/tokens", lambda route: route.fulfill(
        status=200,
        content_type="application/json",
        body='[{"mintAddress":"TokenMint123","symbol":"TEST","name":"Test Token"}]'
    ))

    # Important: The app merges API data with LocalStorage.
    # We mock the API to return a wallet.
    page.route("**/api/bundler/wallets?action=load-all", lambda route: route.fulfill(
        status=200,
        content_type="application/json",
        body='{"wallets":[{"publicKey":"WalletPubkey123456789","secretKey":"...","solBalance":1.5,"tokenBalance":100,"isActive":true,"role":"dev","label":"Wallet 1"}]}'
    ))

    page.route("**/api/bundler/wallets", lambda route: route.fulfill(
        status=200,
        content_type="application/json",
        body='{"wallets":[{"publicKey":"WalletPubkey123456789","solBalance":1.5,"tokenBalance":100,"isActive":true,"role":"dev","label":"Wallet 1"}]}'
    ))

    # Mock stats to prevent errors
    page.route("**/api/stats?type=dashboard", lambda route: route.fulfill(json={"activeTokens": 1, "totalVolume24h": "100", "bundledTxs": 10, "holdersGained": 5}))
    page.route("**/api/stats?type=activity&limit=5", lambda route: route.fulfill(json=[]))
    page.route("**/api/stats?type=volume-bot", lambda route: route.fulfill(json={"activePairs": 0, "tradesToday": 0, "volumeGenerated": "0", "solSpent": "0"}))
    page.route("**/api/pnl?type=summary", lambda route: route.fulfill(json={}))
    page.route("**/api/pnl?type=tokens", lambda route: route.fulfill(json=[]))
    page.route("**/api/pnl?type=trades&limit=100", lambda route: route.fulfill(json=[]))
    page.route("**/api/network", lambda route: route.fulfill(json={"network": "mainnet-beta", "pumpFunAvailable": True, "rpcHealthy": True}))
    page.route("**/api/jito/tip-floor", lambda route: route.fulfill(json={"recommended": True, "sol": {"p75": 0.001}}))
    page.route("**/api/fees/priority", lambda route: route.fulfill(json={"fast": {"feeSol": 0.0001}}))
    page.route("**/api/dashboard/stats**", lambda route: route.fulfill(json={"totalSol": 1.5, "totalTokens": 100, "unrealizedPnl": 0, "activeWallets": 1, "price": 0.1}))
    page.route("**/api/tokens/finance**", lambda route: route.fulfill(json={}))


    print("Navigating...")
    page.goto("http://localhost:3000/dashboard")
    page.wait_for_timeout(3000)

    # Click Open Main Stage
    print("Clicking Open Main Stage...")
    try:
        btn = page.get_by_test_id("open-main-stage")
        if btn.is_visible():
            btn.click()
            page.wait_for_timeout(2000)
        else:
            print("Button not visible!")
    except Exception as e:
        print(f"Click failed: {e}")

    # Check if we switched
    if page.get_by_text("VOLUME BOT").is_visible():
        print("Switched to Main Stage successfully.")
    else:
        print("Failed to switch to Main Stage. Dumping screenshot.")
        page.screenshot(path="verification/failed_switch.png")
        # Proceed anyway to see if we can find the wallet row (maybe already there?)

    # Find wallet row
    print("Looking for wallet row...")
    try:
        # We try to find the row by test-id we added
        row = page.get_by_test_id("wallet-row-0")
        if row.is_visible():
            print("Wallet row found. Clicking...")
            row.click()
            page.wait_for_timeout(1000)

            # Check for dialog
            if page.get_by_test_id("wallet-trade-dialog").is_visible():
                print("Dialog visible. Capturing screenshot.")
                page.screenshot(path="verification/final_success.png")
            else:
                print("Dialog not visible.")
                page.screenshot(path="verification/failed_dialog.png")
        else:
            print("Wallet row not visible.")
            page.screenshot(path="verification/failed_row.png")
            # print html to debug
            # print(page.content())
    except Exception as e:
        print(f"Error: {e}")

    browser.close()

if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
