import importlib.util
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('telegram_notify', Path(__file__).resolve().parents[1] / 'scripts/telegram_notify.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TelegramTests(unittest.TestCase):
    def test_no_token_does_not_send(self):
        with patch.dict(m.os.environ, {}, clear=True), patch.object(m, 'api') as api:
            state, status = m.reminders({'entries': []}, {}, '2026-11-05T05:00:00+00:00')
        api.assert_not_called()
        self.assertEqual(state, {})
        self.assertIn('не подключен', status)

    def test_ignores_unverified_start_message(self):
        with patch.object(m, 'api', side_effect=[{'username': 'fit_requests_notify_bot'}, [{'message': {'chat': {'type': 'private', 'id': 123}, 'text': '/start'}}]]):
            chat, state = m.get_chat('fake-test-token', {})
        self.assertIsNone(chat)
        self.assertEqual(state, {})

    def test_sends_only_to_verified_chat_and_deduplicates(self):
        registry = {'entries': [{'id': 'a', 'expires': '2026-11-12', 'ru': 'https://free.fitauto.ru/'}]}
        with patch.dict(m.os.environ, {'TELEGRAM_BOT_TOKEN': 'fake-test-token'}, clear=True), patch.object(m, 'get_chat', return_value=(123, {})), patch.object(m, 'api') as api:
            state, _ = m.reminders(registry, {}, '2026-11-05T05:00:00+00:00')
            api.assert_called_once()
            self.assertEqual(api.call_args.args[2]['chat_id'], 123)
        with patch.dict(m.os.environ, {'TELEGRAM_BOT_TOKEN': 'fake-test-token'}, clear=True), patch.object(m, 'get_chat', return_value=(123, state)), patch.object(m, 'api') as api:
            m.reminders(registry, state, '2026-11-05T06:00:00+00:00')
            api.assert_not_called()
