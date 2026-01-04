from playwright.sync_api import sync_playwright

def verify_labels(page):
    page.goto("http://localhost:3000/dashboard")

    # Wait for the dashboard to load (look for "DASHBOARD FLOW" text)
    page.wait_for_selector("text=DASHBOARD FLOW")

    # Check Token Name label and input association
    token_name_label = page.locator("label[for='token-name']")
    token_name_input = page.locator("input#token-name")

    if token_name_label.count() > 0 and token_name_input.count() > 0:
        print("✅ Token Name label and input found and associated.")
    else:
        print("❌ Token Name label or input not found/associated.")

    # Check Launch Settings Dev Buy Amount
    dev_buy_label = page.locator("label[for='dev-buy-amount']")
    dev_buy_input = page.locator("input#dev-buy-amount")

    if dev_buy_label.count() > 0 and dev_buy_input.count() > 0:
        print("✅ Dev Buy Amount label and input found and associated.")
    else:
        print("❌ Dev Buy Amount label or input not found/associated.")

    # Take a screenshot of the Launch Token form
    page.screenshot(path="verification/dashboard_labels.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            verify_labels(page)
        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()
