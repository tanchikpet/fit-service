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
        page.goto(origin + "/registry.html")
        page.wait_for_selector(".row")
        assert page.locator(".row").count() == 108
        page.select_option("#scope", "archive")
        assert page.locator(".row").count() == 178
        page.select_option("#scope", "active")
        page.click("#connect")
        page.fill("#token", "test-token-not-real")
        page.locator("#authForm button[type=submit]").click()
        page.wait_for_function("!document.getElementById('auth').open")
        page.click("#add")
        page.fill("#ru", "https://test-created.fitauto.ru/")
        page.fill("#project", "Тестовый проект")
        page.fill("#description", "Новая тестовая страница")
        page.fill("#owner", "Тестовый ответственный")
        page.fill("#expires", "2026-11-30")
        page.click("#saveEntry")
        page.wait_for_function("!document.getElementById('editor').open")
        assert len(files["data/registry.json"]["entries"]) == 287
        # Editing survives a GitHub conflict without changing the saved record.
        page.fill("#search", "test-created")
        page.locator("button[data-edit]").click()
        page.fill("#description", "Измененное описание")
        conflict = True
        page.click("#saveEntry")
        page.wait_for_function("document.getElementById('editorError').textContent.includes('изменились')")
        assert files["data/registry.json"]["entries"][-1]["description"] == "Новая тестовая страница"
        conflict = False
        page.click("#saveEntry")
        page.wait_for_function("!document.getElementById('editor').open")
        assert files["data/registry.json"]["entries"][-1]["description"] == "Измененное описание"
        page.fill("#search", "")
        page.select_option("#scope", "review")
        page.locator("button[data-approve]").click()
        page.fill("#project", "Проверенный проект")
        page.fill("#description", "Подтвержденная страница")
        page.click("#saveEntry")
        page.wait_for_function("document.querySelectorAll('[data-approve]').length===0")
        assert files["data/registry-candidates.json"]["items"][0]["state"] == "approved"
        assert page.evaluate("localStorage.length") == 0
        page.set_viewport_size({"width": 390, "height": 844})
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        # Existing FIT Requests and intake scripts must continue working together.
        page.goto(origin + "/fit-requests/")
        page.locator('[data-action="newpm"]').click()
        page.fill("#requestTitle", "Тест заявки на страницу")
        page.fill("#requestRequester", "Тестовый инициатор")
        page.fill("#requestDescription", "Создать страницу")
        page.select_option("#requestProject", "site")
        page.select_option("#requestPageAction", "close")
        page.fill("#requestActualUrl", "https://free.fitauto.ru/")
        page.fill("#requestPagePurpose", "Тест закрытия страницы")
        page.fill("#requestPageOwner", "Ответственный")
        page.click("#submitIntake")
        assert page.locator("#requestDialog").evaluate("e=>e.open")
        page.fill("#requestRedirectTo", "https://fitauto.ru/")
        page.select_option("#requestStatus", "Готово")
        page.click("#submitIntake")
        page.wait_for_function("document.getElementById('pageGithubDialog').open")
        page.fill("#pageGithubToken", "test-token-not-real")
        page.locator("#pageGithubForm button[type=submit]").click()
        page.wait_for_function("!document.getElementById('pageGithubDialog').open")
        page.wait_for_function("document.getElementById('toast').textContent.includes('сохранены в GitHub')")
        assert files["data/page-requests.json"]["items"][0]["redirectTo"] == "https://fitauto.ru/"
        page.locator('tr[data-id]').first.click()
        page.locator('[data-publish-page]').click()
        page.wait_for_function("document.getElementById('toast').textContent.includes('перенесена в архив')")
        entry = next(e for e in files["data/registry.json"]["entries"] if e["ru"] == "https://free.fitauto.ru/")
        assert entry["status"] == "archive" and entry["redirectRu"] == "https://fitauto.ru/"
        assert not errors, errors
        browser.close()
    server.shutdown()
    print("Browser checks passed: migration, create/edit, conflict, review, mobile, request fields, GitHub save, archive.")


if __name__ == "__main__":
    main()
