"""Browser acceptance checks. GitHub and SMTP are never contacted by tests."""
import base64
import functools
import http.server
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
files = {p: json.loads((ROOT / p).read_text()) for p in ["data/registry.json", "data/registry-checks.json", "data/registry-candidates.json", "data/page-requests.json"]}
files["data/registry-candidates.json"]["items"] = [{"id": "found-test", "url": "https://new-test.fitauto.ru/", "source": "Тестовый источник", "state": "pending", "foundAt": "2026-11-05"}]
commits = []
conflict = False


def api(route):
    global conflict
    req = route.request
    path = req.url.split("/contents/", 1)[-1].split("?", 1)[0]
    if "/dispatches" in req.url:
        route.fulfill(status=204)
        return
    if path not in files:
        route.fulfill(status=404, json={})
        return
    if req.method == "PUT":
        if conflict:
            route.fulfill(status=409, json={})
            return
        body = req.post_data_json
        value = json.loads(base64.b64decode(body["content"]).decode())
        assert "test-token-not-real" not in json.dumps(value)
        assert body["sha"] == "sha-test"
        files[path] = value
        commits.append((path, value))
        route.fulfill(json={"content": {"sha": "sha-test"}})
    else:
        route.fulfill(json={"sha": "sha-test", "content": base64.b64encode(json.dumps(files[path], ensure_ascii=False).encode()).decode()})


def main():
    global conflict
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1360, "height": 950})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("https://api.github.com/**", api)
        page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
        # The former registry page now redirects to the production app.
        # Intercept its destination: this test must never access production.
        destination = "https://fit-requests-kaiten-api-production.up.railway.app/app/registry"
        page.route(destination + "**", lambda r: r.fulfill(body="<h1>Registry destination</h1>", content_type="text/html"))
        page.goto(origin + "/registry.html")
        page.wait_for_url(destination)
        assert page.locator("h1").inner_text() == "Registry destination"
        page.set_viewport_size({"width": 390, "height": 844})
        # Existing FIT Requests and intake scripts must continue working together.
        page.goto(origin + "/fit-requests/")
        page.locator('[data-action="newpm"]').click()
        page.fill("#requestTitle", "Тест заявки на страницу")
        page.fill("#requestRequester", "Тестовый инициатор")
        page.fill("#requestDescription", "Создать страницу")
        page.select_option("#requestProject", "site")
        page.fill("#requestOwner", "Ответственный")
        page.fill("#requestPageUrl", "https://free.fitauto.ru/")
        page.click("#submitIntake")
        page.wait_for_function("!document.getElementById('requestDialog').open")
        page.reload()
        page.locator('tr[data-id]').first.click()
        assert "Ответственный" in page.locator("#main").inner_text()

        # Each scenario validates only its own fields and restores saved values.
        for kind in ["new", "update", "other"]:
            page.locator('#main [data-page="requests"]').first.click()
            page.locator('[data-action="new"]').click()
            page.locator(f'[data-kind="{kind}"]').click()
            page.click("#submitIntake")
            assert page.locator("#requestDialog").evaluate("e=>e.open")
            for control in page.locator("#intakeForm [required]").all():
                input_type = control.get_attribute("type")
                value = "https://test.fitauto.ru/" if input_type == "url" else "2026-12-01" if input_type == "date" else "Тест " + kind
                control.fill(value)
            page.fill("#requestExpress", "https://example.org/chat")
            if kind == "new":
                page.fill("#requestPromoCode", "TEST2026")
                page.fill("#requestSourceId", "000000237")
                page.fill("#requestCampaignEnd", "2026-11-01")
                page.click("#submitIntake")
                assert page.locator("#requestDialog").evaluate("e=>e.open")
                page.fill("#requestCampaignEnd", "2026-12-31")
            page.click("#submitIntake")
            page.wait_for_function("!document.getElementById('requestDialog').open")
            page.reload()
            page.locator('tr[data-id]').first.click()
            page.locator('[data-edit]').click()
            assert page.locator(f'[data-kind="{kind}"]').get_attribute("aria-pressed") == "true"
            assert page.locator("#requestExpress").input_value() == "https://example.org/chat"
            if kind == "new":
                assert page.locator("#requestSourceId").input_value() == "000000237"
                assert page.locator("#requestPromoCode").input_value() == "TEST2026"
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
            page.click("#cancelIntake")

        # Incomplete drafts survive reload and switching hides irrelevant requirements.
        page.locator('#main [data-page="requests"]').first.click()
        page.locator('[data-action="new"]').click()
        page.locator('[data-kind="new"]').click()
        page.fill("#requestTitle", "Черновик акции")
        page.fill("#requestPromoCode", "KEEP")
        page.click("#saveDraft")
        page.wait_for_function("!document.getElementById('requestDialog').open")
        page.reload()
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        assert page.locator("#requestPromoCode").input_value() == "KEEP"
        page.locator('[data-kind="other"]').click()
        page.fill("#requestOwner", "Ответственный")
        page.fill("#requestDescription", "Другая задача")
        page.fill("#requestPageUrl", "javascript:alert(1)")
        page.click("#submitIntake")
        assert page.locator("#requestDialog").evaluate("e=>e.open")
        page.fill("#requestPageUrl", "https://fitauto.ru/")
        page.click("#submitIntake")
        page.wait_for_function("!document.getElementById('requestDialog').open")

        # Legacy page requests must still save and archive through the registry bridge.
        legacy = {"id": "REQ-999", "title": "Закрытие существующей страницы",
                  "description": "Тест закрытия страницы", "project": "site",
                  "pageAction": "close", "actualUrl": "https://free.fitauto.ru/",
                  "pagePurpose": "Тест закрытия страницы", "pageOwner": "Ответственный",
                  "redirectTo": "https://fitauto.ru/", "status": "Готово",
                  "created": "2026-11-25", "mode": "pm"}
        page.evaluate("""task => {
            const key = 'fit-requests-prototype-v1';
            const tasks = JSON.parse(localStorage.getItem(key));
            tasks.unshift(task);
            localStorage.setItem(key, JSON.stringify(tasks));
        }""", legacy)
        page.reload()
        page.locator('#main [data-page="requests"]').first.click()
        page.locator('tr[data-id="REQ-999"]').click()
        page.locator('[data-save-page]').click()
        page.wait_for_function("document.getElementById('pageGithubDialog').open")
        page.fill("#pageGithubToken", "test-token-not-real")
        page.locator("#pageGithubForm button[type=submit]").click()
        page.wait_for_function("!document.getElementById('pageGithubDialog').open")
        page.wait_for_function("document.getElementById('toast').textContent.includes('сохранены в GitHub')")
        assert files["data/page-requests.json"]["items"][0]["redirectTo"] == "https://fitauto.ru/"
        page.locator('[data-publish-page]').click()
        page.wait_for_function("document.getElementById('toast').textContent.includes('перенесена в архив')")
        entry = next(e for e in files["data/registry.json"]["entries"] if e["ru"] == "https://free.fitauto.ru/")
        assert entry["status"] == "archive" and entry["redirectRu"] == "https://fitauto.ru/"
        assert not errors, errors
        browser.close()
    server.shutdown()
    print("Browser checks passed: registry redirect, campaign forms, required fields, dates, URLs, drafts, mobile, reload, legacy GitHub save and archive.")


if __name__ == "__main__":
    main()
