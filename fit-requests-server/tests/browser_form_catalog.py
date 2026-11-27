"""Browser checks with isolated catalog fixtures and optional review screenshots."""
from copy import deepcopy
import functools
import http.server
import os
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright

from browser_intake import ROOT, schemas


def main():
    server = http.server.ThreadingHTTPServer(
        ('127.0.0.1', 0),
        functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT/'public'),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    original = deepcopy(schemas[0])
    updated = deepcopy(original)
    updated.update(id='100', number=2)
    updated['schema']['sections'][0]['fields'] = [
        field for field in updated['schema']['sections'][0]['fields'] if field['id'] != 'promoCode'
    ]
    updated['schema']['sections'].append({
        'id':'launch','name':'Запуск',
        'fields':[{'id':'field-channel','label':'Канал запуска','type':'select','required':True,
                   'hint':'Выбери канал, в котором появится акция.',
                   'options':[{'id':'site','label':'Сайт'},{'id':'app','label':'Приложение'}]}],
    })
    admin_item = {
        'id':'new','position':0,'state':'active','draft':deepcopy(original['schema']),
        'revision':1,'current_version_id':original['id'],
        'versions':[{'id':original['id'],'number':1,'publishedAt':'2026-11-27T00:00:00Z','publishedBy':'migration'}],
    }
    active = [original]
    writes = []

    def routes(route):
        path = route.request.url.split('/api/', 1)[1]
        if path == 'admin/form-types':
            if route.request.method == 'POST':
                body = route.request.post_data_json
                assert body['action'] == 'publish'
                admin_item.update(draft=body['schema'],revision=2,current_version_id='100')
                admin_item['versions'].insert(0,{'id':'100','number':2,'publishedAt':'2026-11-27T02:00:00Z','publishedBy':'999'})
            route.fulfill(json={'items':[admin_item]})
        elif path == 'form-types':
            route.fulfill(json={'items':active})
        elif path == 'me':
            route.fulfill(json={'telegramId':'111','displayName':'Тестовый заказчик','role':'employee'})
        elif path == 'requests' and route.request.method == 'GET':
            route.fulfill(json={'items':[]})
        elif path == 'requests':
            body = route.request.post_data_json
            writes.append(body)
            if body['formVersionId'] != active[0]['id']:
                route.fulfill(status=409,json={'code':'form_changed','error':'Форма изменилась'})
            else:
                route.fulfill(status=201,json={'item':{**body,'title':body['formAnswers']['title'],
                                                      'formVersion':active[0],'id':'REQ-2000','revision':1}})
        else:
            route.fulfill(status=404,json={'error':'not_found'})

    screenshot_dir = os.getenv('FIT_FORM_SCREENSHOTS')
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.getenv('FIT_TEST_CHROMIUM'))
            page = browser.new_page(viewport={'width':1440,'height':1000})
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.route('**/api/**',routes)
            page.goto(origin+'/ui/form-admin.html')
            expect(page.locator('#typeEditor h2')).to_have_text('Новая акция')
            page.get_by_role('button',name='Добавить раздел').click()
            section=page.locator('.form-admin-section').last
            section.get_by_label('Название раздела').fill('Запуск')
            section.get_by_role('button',name='Добавить поле').click()
            field=section.locator('details[open]')
            field.get_by_label('Название поля').fill('Канал запуска')
            field.locator('select').first.select_option('select')
            field.get_by_role('button',name='Вариант',exact=False).click()
            field.get_by_label('Название варианта').fill('Сайт')
            field.get_by_label('Обязательное поле').check()
            page.get_by_role('button',name='Предпросмотр',exact=True).click()
            expect(page.locator('#formPreview')).to_be_visible()
            expect(page.locator('#previewFields h3')).to_contain_text('Запуск')
            expect(page.locator('#previewFields select option').last).to_have_text('Сайт')
            page.locator('#formPreview .modal-actions button').click()
            page.get_by_role('button',name='Опубликовать версию').click()
            expect(page.locator('#catalogStatus')).to_have_text('Новая версия опубликована')
            expect(page.locator('#typeEditor > p').first).to_contain_text('Версия 2')
            if screenshot_dir:
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=Path(screenshot_dir)/'form-admin.png',full_page=True)
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.set_viewport_size({'width':1440,'height':1000})
            page.goto(origin+'/ui/index.html')
            expect(page.locator('#userDisplayName')).to_have_text('Тестовый заказчик')
            page.locator('[data-action="new"]').click()
            page.locator('#requestTitle').fill('Весенняя акция')
            page.locator('#requestPromoCode').fill('0007')
            active[0]=updated
            page.locator('#saveDraft').click()
            expect(page.locator('#intakeError')).to_contain_text('Совместимые ответы перенесены')
            expect(page.locator('#requestTitle')).to_have_value('Весенняя акция')
            expect(page.locator('#obsoleteAnswers textarea')).to_have_value('Промо-код: 0007')
            expect(page.locator('[data-field="field-channel"] .field-error')).to_have_text('Новое обязательное поле')
            page.locator('[data-field="field-channel"] select').select_option('site')
            if screenshot_dir:
                page.set_viewport_size({'width':1440,'height':2300})
                page.locator('#requestDialog').evaluate('(element)=>element.scrollTop=0')
                page.screenshot(path=Path(screenshot_dir)/'form-customer.png')
            page.locator('#saveDraft').click()
            expect(page.locator('#toast')).to_have_text('Черновик сохранён')
            assert len(writes)==2 and writes[-1]['formAnswers']['field-channel']=='site'
            assert writes[-1]['formVersionId']=='100'
            assert not errors,errors
            browser.close()
    finally:
        server.shutdown()
    print('Browser checks passed: section editor, preview, publish, stale form and preserved values.')


if __name__ == '__main__':
    main()
