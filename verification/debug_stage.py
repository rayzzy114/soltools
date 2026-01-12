
from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()

    # Mock everything again
    page.route("**/api/tokens", lambda route: route.fulfill(
        status=200,
        content_type="application/json",
        body='[{"mintAddress":"TokenMint123","symbol":"TEST","name":"Test Token"}]'
    ))

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


    page.goto("http://localhost:3000/dashboard")
    page.wait_for_timeout(3000)
    page.screenshot(path="verification/step1_loaded.png")

    try:
        page.get_by_role("button", name="Open main stage").click()
        page.wait_for_timeout(1000)
        page.screenshot(path="verification/step2_clicked.png")
    except Exception as e:
        print(f"Error clicking: {e}")
        page.screenshot(path="verification/error_click.png")

    # Look for the wallet row
    try:
        wallet = page.locator("button").filter(has_text="Wallet 1").first
        if wallet.is_visible():
            wallet.click()
            page.wait_for_timeout(1000)
            page.screenshot(path="verification/step3_dialog.png")
        else:
            print("Wallet 1 not visible")
    except Exception as e:
        print(f"Error finding wallet: {e}")

    browser.close()

if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
