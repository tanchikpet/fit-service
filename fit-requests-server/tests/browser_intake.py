"""Run with Python Playwright; all API calls use isolated fixtures, never production."""
import functools
import http.server
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
items = []
next_id = 1000
delete_failure = False
delete_calls = []
save_error = None
write_calls = []
child_calls = []
current_role = 'employee'

def api(route):
    global next_id
    req = route.request
    path = req.url.split('/api/', 1)[1]
    if req.method in ('POST', 'PUT'):
        write_calls.append(req.post_data_json)
        if save_error:
            route.fulfill(status=400,json=save_error)
            return
    if path == 'me':
        route.fulfill(json={'telegramId':'111','displayName':'Тестовый автор','role':current_role})
    elif path == 'requests' and req.method == 'GET':
        route.fulfill(json={'items':items})
    elif path == 'requests' and req.method == 'POST':
        next_id += 1
        item = {**req.post_data_json,'id':f'REQ-{next_id}','revision':1,'createdBy':'111'}
        items.insert(0,item)
        route.fulfill(status=201,json={'item':item})
    elif path.endswith('/kaiten/children'):
        child_calls.append(path)
        route.fulfill(json={'items':[{'id':'902','title':'Дочерняя карточка','estimateText':'8h'}]})
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
    global delete_failure, save_error, current_role
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(http.server.SimpleHTTPRequestHandler,directory=ROOT/'public'))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=os.getenv("FIT_TEST_CHROMIUM"))
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/api/**',api)
        page.goto(f'http://127.0.0.1:{server.server_port}/ui/index.html')
        expect(page.locator('#userDisplayName')).to_have_text('Тестовый автор')
        # Closing protects edits but does not warn for untouched or restored values.
        warning=page.locator('#discardRequestDialog')
        page.locator('[data-action="new"]').click()
        expect(page.locator('.modal-actions button').filter(visible=True)).to_have_text(['Сохранить черновик','Подать заявку'])
        page.locator('#closeIntake').click()
        expect(page.locator('#requestDialog')).to_be_hidden()
        expect(warning).to_be_hidden()

        page.locator('[data-action="new"]').click()
        page.locator('#requestTitle').fill('Несохраненная заявка')
        page.locator('#closeIntake').click()
        expect(warning).to_be_visible()
        expect(warning.locator('h2')).to_have_text('Закрыть без сохранения?')
        expect(warning.get_by_role('button',name='Продолжить редактирование')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.locator('#requestTitle')).to_have_value('Несохраненная заявка')
        page.keyboard.press('Escape')
        expect(warning).to_be_visible()
        page.keyboard.press('Escape')
        expect(warning).to_be_hidden()
        expect(page.locator('#requestDialog')).to_be_visible()
        page.locator('#closeIntake').click()
        warning.get_by_role('button',name='Закрыть без сохранения',exact=True).click()
        expect(page.locator('#requestDialog')).to_be_hidden()
        assert not items

        page.locator('[data-action="new"]').click()
        expect(page.locator('#requestTitle')).to_have_value('')
        page.locator('[data-kind="new"]').click()
        page.keyboard.press('Escape')
        expect(warning).to_be_visible()
        warning.get_by_role('button',name='Продолжить редактирование').click()
        page.locator('[data-kind="other"]').click()
        page.keyboard.press('Escape')
        expect(page.locator('#requestDialog')).to_be_hidden()
        expect(warning).to_be_hidden()
        for kind,count in [('new',14),('update',10),('other',3)]:
            page.locator('[data-action="new"]').click()
            expect(page.locator('[data-kind]')).to_have_count(3)
            page.locator(f'[data-kind="{kind}"]').click()
            expect(page.locator('#intakeForm [required]')).to_have_count(count)
            page.locator('#submitIntake').click()
            expect(page.locator('#requestDialog')).to_be_visible()
            expect(page.locator('#requestTitleError')).to_be_visible()
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
            expect(page.locator('#toast')).to_have_text('Заявка подана')
            page.reload()
            page.locator('tr[data-id]').first.click()
            expect(page.locator('.request-details')).to_contain_text('Тест '+kind)
            page.locator('[data-edit]').click()
            expect(page.locator(f'[data-kind="{kind}"]')).to_have_attribute('aria-pressed','true')
            expect(page.locator('#requestExpress')).to_have_value('https://example.org/project')
            page.locator('#closeIntake').click()
            page.locator('#main [data-page="requests"]').click()
        # Draft is restored after reload; hidden campaign fields do not block another kind.
        page.locator('[data-action="new"]').click()
        page.locator('[data-kind="new"]').click()
        page.locator('#requestTitle').fill('Черновик')
        page.locator('#saveDraft').click()
        expect(page.locator('#toast')).to_have_text('Черновик сохранён')
        page.reload()
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        expect(page.locator('[data-kind="new"]')).to_have_attribute('aria-pressed','true')
        ident=items[0]['id']
        page.locator('#requestTitle').fill('Изменение черновика')
        page.locator('#saveDraft').click()
        expect(page.locator('#toast')).to_have_text('Черновик сохранён')
        assert items[0]['id']==ident
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        page.locator('#requestTitle').fill('Локальное изменение')
        page.keyboard.press('Escape')
        warning.get_by_role('button',name='Закрыть без сохранения',exact=True).click()
        page.locator('[data-edit]').click()
        expect(page.locator('#requestTitle')).to_have_value('Изменение черновика')
        page.locator('[data-kind="other"]').click()
        expect(page.locator('#requestTitle')).to_have_value('Изменение черновика')
        page.locator('#requestOwner').fill('Ответственный')
        page.locator('#requestActualUrl').fill('javascript:alert(1)')
        page.locator('#requestDescription').fill('Описание')
        page.locator('#submitIntake').click()
        expect(page.locator('#requestActualUrlError')).to_be_visible()
        page.locator('#requestActualUrl').fill('')
        save_error={'error':'Проверь ответственного','field':'owner'}
        page.locator('#submitIntake').click()
        expect(page.locator('#requestOwnerError')).to_contain_text('Проверь ответственного')
        expect(page.locator('#requestDescription')).to_have_value('Описание')
        expect(page.locator('#requestTitle')).to_have_value('Изменение черновика')
        failed_key=write_calls[-1]['operationId']
        save_error=None
        page.locator('#submitIntake').click()
        expect(page.locator('#toast')).to_have_text('Заявка подана')
        assert write_calls[-1]['operationId']==failed_key
        assert len(items)==4 and items[0]['id']==ident and items[0]['status']=='Новая'
        page.locator('tr[data-id]').first.click()
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
        expect(page.locator('#toast')).to_have_text('Черновик сохранён')
        page.locator('tr[data-id]').first.click()
        page.locator('[data-edit]').click()
        expect(page.locator('#deleteIntake')).to_have_text('Удалить черновик')
        page.once('dialog',lambda dialog:dialog.accept())
        page.locator('#deleteIntake').click()
        expect(page.locator('#toast')).to_have_text('Заявка удалена')
        # Even if another user's record is present in a response, no delete control is shown.
        items.insert(0,{'id':'REQ-9999','title':'Чужая заявка','createdBy':'222','revision':1,'status':'Новая','actualUrl':'https://example.org/old'})
        page.reload()
        page.locator('tr[data-id="REQ-9999"]').click()
        expect(page.locator('.request-details')).to_contain_text('https://example.org/old')
        expect(page.locator('[data-delete-request]')).to_have_count(0)
        page.locator('[data-edit]').click()
        expect(page.locator('#deleteIntake')).to_be_hidden()
        page.set_viewport_size({'width':390,'height':844})
        expect(page.locator('[data-kind="new"]')).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        page.keyboard.press('Escape')
        expect(page.locator('#requestDialog')).to_be_hidden()
        page.set_viewport_size({'width':1280,'height':900})
        linked = {'id':'REQ-9998','title':'Переданная заявка','createdBy':'111','revision':1,
                  'status':'Передана в Kaiten','description':'Описание для заказчика','owner':'Автор акции'}
        items.insert(0,linked)
        page.reload()
        page.locator('tr[data-id="REQ-9998"]').click()
        expect(page.locator('.detail-desc')).to_have_text('Описание для заказчика')
        expect(page.locator('.pill')).to_have_text('Передана в Kaiten')
        expect(page.locator('#kaitenParentPanel,#kaitenChildrenPanel')).to_have_count(0)
        assert not child_calls
        page.locator('[data-edit]').click()
        expect(page.locator('#requestOwner')).to_have_value('Автор акции')
        page.keyboard.press('Escape')

        current_role = 'admin'
        linked.update(status='Новая',kaitenParent={'id':'901','title':'Основная карточка','estimateText':'8h'})
        page.reload()
        page.locator('tr[data-id="REQ-9998"]').click()
        expect(page.locator('#kaitenParentPanel')).to_contain_text('8h')
        expect(page.locator('#kaitenChildrenPanel')).to_contain_text('Дочерняя карточка')
        assert len(child_calls)==1
        assert not errors,errors
        browser.close()
    server.shutdown()
    print('Browser checks passed: all scenarios, persistence, drafts, deletion, cancel, failure, ownership, mobile, employee/admin details.')

if __name__=='__main__':
    main()
