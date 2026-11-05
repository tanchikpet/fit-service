import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).resolve().parents[1] / "scripts/registry_monitor.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RegistryTests(unittest.TestCase):
    def test_private_redirect_is_rejected(self):
        with patch.object(m.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 80))]):
            with self.assertRaisesRegex(ValueError, "публичным"):
                m.public_target("http://localhost/")

    def test_failed_probe_retains_previous_destination(self):
        with patch.object(m, "fetch", side_effect=TimeoutError("timeout")):
            _, c, _ = m.check("https://free.fitauto.ru/", {"finalUrl": "https://fitauto.ru/"}, "", "2026-11-05T05:00:00+00:00")
        self.assertEqual(c["finalUrl"], "https://fitauto.ru/")
        self.assertFalse(c["changed"])
        self.assertIn("error", c)

    def test_changed_and_unexpected_redirect(self):
        with patch.object(m, "fetch", return_value=(200, "https://fitauto.ru/", "text/html", b"<a href='/about/'>a</a>")):
            _, c, links = m.check("https://free.fitauto.ru/", {"finalUrl": "https://free.fitauto.ru/"}, "https://check.fitauto.ru/", "now")
        self.assertTrue(c["changed"])
        self.assertTrue(c["expectedMismatch"])
        self.assertEqual(links, ["https://fitauto.ru/about/"])

    def test_expiry_email_deduplicates_and_excludes_archive(self):
        registry = {"entries": [{"id": "a", "status": "active", "expires": "2026-11-12", "ru": "https://free.fitauto.ru/"}, {"id": "b", "status": "archive", "expires": "2026-11-12"}]}
        env = {"ALERT_EMAIL": "test@example.com", "SMTP_HOST": "smtp.example.com", "SMTP_USER": "u", "SMTP_PASSWORD": "secret", "SMTP_FROM": "bot@example.com", "SMTP_PORT": ""}
        with patch.dict(m.os.environ, env, clear=True), patch.object(m.smtplib, "SMTP_SSL") as smtp:
            sent, _ = m.reminders(registry, {}, "2026-11-05T05:00:00+00:00")
            again, message = m.reminders(registry, sent, "2026-11-05T07:00:00+00:00")
            smtp.return_value.send_message.assert_called_once()
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent, again)
            self.assertIn("Нет новых", message)

    def test_no_mail_credentials_does_not_mark_sent(self):
        with patch.dict(m.os.environ, {}, clear=True):
            sent, status = m.reminders({"entries": []}, {}, "2026-11-05T05:00:00+00:00")
        self.assertEqual(sent, {})
        self.assertIn("не подключена", status)

    def test_failed_email_does_not_record_delivery(self):
        env = {"ALERT_EMAIL": "a@example.com", "SMTP_HOST": "smtp.example.com", "SMTP_USER": "u", "SMTP_PASSWORD": "s", "SMTP_FROM": "b@example.com"}
        previous = {}
        with patch.dict(m.os.environ, env, clear=True), patch.object(m.smtplib, "SMTP_SSL", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                m.reminders({"entries": [{"id": "a", "expires": "2026-11-12"}]}, previous, "2026-11-05T05:00:00+00:00")
        self.assertEqual(previous, {})

    def test_owned_domain_boundary(self):
        self.assertTrue(m.owned("https://free.fitauto.ru/"))
        self.assertFalse(m.owned("https://fitauto.ru.attacker.example/"))
        self.assertFalse(m.owned("https://notfitauto.ru/"))


if __name__ == "__main__":
    unittest.main()
