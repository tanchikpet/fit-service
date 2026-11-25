"""Run with Python Playwright; all API calls use isolated fixtures, never production."""
import functools
import http.server
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
items = []
next_id = 1000
delete_failure = False
delete_calls = []

def api(route):
    global next_id
    req = route.request
    path = req.url.split('/api/', 1)[1]
    if path == 'me':
        route.fulfill(json={'telegramId':'111','displayName':'Тестовый автор','role':'employee'})
    elif path == 'requests' and req.method == 'GET':
        route.fulfill(json={'items':items})
    elif path == 'requests' and req.method == 'POST':
        next_id += 1
        item = {**req.post_data_json,'id':f'REQ-{next_id}','revision':1,'createdBy':'111'}
        items.insert(0,item)
        route.fulfill(status=201,json={'item':item})
    elif path.startswith('requests/'):
        ident = path.split('/')[1]
        item = next((x for x in items if x['id']==ident),None)
        if req.method == 'DELETE':
            delete_calls.append(ident)
            if delete_failure:
                route.fulfill(status=409,json={'error':'Заявка изменена. Обнови страницу.'})
            elif item and item['createdBy']=='111' and item['revision']==req.post_data_json['revision']:
                items.remove(item)
                route.fulfill(json={'ok':True})
            else:
                route.fulfill(status=403,json={'error':'Нет доступа'})
        elif req.method == 'PUT' and item:
            item.update(req.post_data_json)
            item['revision'] += 1
            route.fulfill(json={'item':item})
        else:
            route.fulfill(status=404,json={'error':'not_found'})
    else:
        route.fulfill(status=404,json={'error':'not_found'})

def main():
    global delete_failure
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(http.server.SimpleHTTPRequestHandler,directory=ROOT/'public'))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as pw:
        browser=pw.chromium.launch()
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/api/**',api)
        page.goto(f'http://127.0.0.1:{server.server_port}/ui/index.html')
        expect(page.locator('#userDisplayName')).to_have_text('Тестовый автор')
        for kind,count in [('new',14),('update',10),('other',4)]:
            page.locator('[data-action="new"]').click()
            expect(page.locator('[data-kind]')).to_have_count(3)
            page.locator(f'[data-kind="{kind}"]').click()
            expect(page.locator('#intakeForm [required]')).to_have_count(count)
            page.locator('#submitIntake').click()
            expect(page.locator('#requestDialog')).to_be_visible()
            for field in page.locator('#intakeForm [required]').all():
                typ=field.get_attribute('type')
                field.fill('https://fitauto.ru/' if typ=='url' else '2026-12-01' if typ=='date' else 'Тест '+kind)
            page.locator('#requestExpress').fill('https://example.org/project')
            if kind=='new':
                page.locator('#requestSourceId').fill('000000237')
                page.locator('#requestCampaignEnd').fill('2026-11-01')
                page.locator('#submitIntake').click()
                expect(page.locator('#requestDialog')).to_be_visible()
                page.locator('#requestCampaignEnd').fill('2026-12-31')
            page.locator('#submitIntake').click()
            expect(page.locator('#toast')).to_have_text('Сохранено в PostgreSQL')
            page.reload()
            page.locator('tr[data-id]').first.click()
            expect(page.locator('.request-details')).to_contain_text('Тест '+kind)
            page.locator('[data-edit]').click()
            expect(page.locator(f'[data-kind="{kind}"]')).to_have_attribute('aria-pressed','true')
            expect(page.locator('#requestExpress')).to_have_value('https://example.org/project')
            page.locator('#cancelIntake').click()
            page.locator('#main [data-page="requests"]').click()
        # Draft is restored after reload; hidden campaign fields do not block another kind.
        page.locator('[data-action="new"]').click()
        page.locator('[data-kind="new"]').click()
        page.locator('#requestTitle').fill('Черновик')
        page.locator('#saveDraft').click()
        expect(page.locator('#toast')).to_have_text('Сохранено в PostgreSQL')
        page.reload()
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        expect(page.locator('[data-kind="new"]')).to_have_attribute('aria-pressed','true')
        page.locator('[data-kind="other"]').click()
        page.locator('#requestActualUrl').fill('javascript:alert(1)')
        page.locator('#requestDescription').fill('Описание')
        page.locator('#submitIntake').click()
        expect(page.locator('#requestDialog')).to_be_visible()
        page.locator('#requestActualUrl').fill('https://fitauto.ru/')
        page.locator('#submitIntake').click()
        expect(page.locator('#toast')).to_have_text('Сохранено в PostgreSQL')
        page.locator('tr[data-id]').first.click()
        ident=items[0]['id']
        # Cancel leaves the request and sends no DELETE.
        page.once('dialog',lambda dialog:dialog.dismiss())
        page.locator('[data-delete-request]').click()
        assert not delete_calls
        # Server failure leaves both the detail and persisted data intact.
        delete_failure=True
        page.once('dialog',lambda dialog:dialog.accept())
        page.locator('[data-delete-request]').click()
        expect(page.locator('#toast')).to_contain_text('Не удалось удалить')
        assert any(x['id']==ident for x in items)
        delete_failure=False
        page.once('dialog',lambda dialog:dialog.accept())
        page.locator('[data-delete-request]').click()
        expect(page.locator('#toast')).to_have_text('Заявка удалена')
        page.reload()
        expect(page.locator(f'tr[data-id="{ident}"]')).to_have_count(0)
        # A draft can also be removed directly from the edit dialog.
        page.locator('[data-action="new"]').click()
        page.locator('#saveDraft').click()
        expect(page.locator('#toast')).to_have_text('Сохранено в PostgreSQL')
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        expect(page.locator('#deleteIntake')).to_have_text('Удалить черновик')
        page.once('dialog',lambda dialog:dialog.accept())
        page.locator('#deleteIntake').click()
        expect(page.locator('#toast')).to_have_text('Заявка удалена')
        # Even if another user's record is present in a response, no delete control is shown.
        items.insert(0,{'id':'REQ-9999','title':'Чужая заявка','createdBy':'222','revision':1,'requestKind':'other','status':'Новая'})
        page.reload()
        page.locator('tr[data-id="REQ-9999"]').click()
        expect(page.locator('[data-delete-request]')).to_have_count(0)
        page.locator('[data-edit]').click()
        expect(page.locator('#deleteIntake')).to_be_hidden()
        page.set_viewport_size({'width':390,'height':844})
        expect(page.locator('[data-kind="new"]')).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        assert not errors,errors
        browser.close()
    server.shutdown()
    print('Browser checks passed: all scenarios, persistence, drafts, deletion, cancel, failure, ownership, mobile.')

if __name__=='__main__':
    main()
