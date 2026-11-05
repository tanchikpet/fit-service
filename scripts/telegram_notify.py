"""Telegram reminders; a one-time private message binds the recipient securely."""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import urllib.request
from zoneinfo import ZoneInfo
from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parents[1]


def api(token, method, data=None):
    request = urllib.request.Request("https://api.telegram.org/bot" + token + "/" + method, data=json.dumps(data or {}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        if not result.get("ok"):
            raise RuntimeError("Telegram отклонил запрос. Проверь токен и доступ бота к чату.")
        return result["result"]
    except Exception:
        # urllib errors contain the request URL, including the token. Never log it.
        raise RuntimeError("Ошибка Telegram. Проверь токен, доступ бота к чату и сеть.") from None


def get_chat(token, previous):
    box = Fernet(base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()))
    binding = previous.get("telegram-binding")
    if binding:
        try:
            return confirm_chat(token, json.loads(box.decrypt(binding.encode()))["chat_id"], dict(previous))
        except (InvalidToken, ValueError, KeyError):
            raise RuntimeError("Привязка Telegram не подходит к текущему токену. Нужна повторная привязка.") from None
    config = json.loads((ROOT / "data/telegram-setup.json").read_text())
    bot = api(token, "getMe")
    if bot.get("username", "").lower() != config["botUsername"].lower():
        raise RuntimeError("Токен принадлежит другому боту; ожидается @" + config["botUsername"])
    updates = api(token, "getUpdates", {"limit": 100, "timeout": 0, "allowed_updates": ["message"]})
    chats = set()
    for update in updates:
        message = update.get("message", {})
        chat = message.get("chat", {})
        text = message.get("text", "").strip()
        if chat.get("type") != "private" or not text.startswith("/connect "):
            continue
        code = text.split(" ", 1)[1].strip()
        if hashlib.sha256(code.encode()).hexdigest() == config["codeSha256"]:
            chats.add(chat["id"])
    if len(chats) != 1:
        return None, previous
    chat_id = chats.pop()
    result = dict(previous)
    result["telegram-binding"] = box.encrypt(json.dumps({"chat_id": chat_id}).encode()).decode()
    return confirm_chat(token, chat_id, result)


def confirm_chat(token, chat_id, state):
    if not state.get("telegram-confirmed"):
        api(token, "sendMessage", {"chat_id": chat_id, "text": "✅ Реестр FIT SERVICE подключен. Здесь будут приходить напоминания за 7, 3, 1 день и в день окончания акции.\n\nОткрыть реестр: https://tanchikpet.github.io/fit-service/registry.html", "link_preview_options": {"is_disabled": True}})
        state["telegram-confirmed"] = dt.datetime.now(dt.timezone.utc).isoformat()
    return chat_id, state


def reminders(registry, previous, now):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        return previous, "Telegram не подключен: добавь TELEGRAM_BOT_TOKEN в секреты GitHub."
    chat, sent = get_chat(token, previous)
    if chat is None:
        return sent, "Бот @fit_requests_notify_bot доступен. Ожидается личное сообщение с кодом подключения."
    today = dt.datetime.fromisoformat(now).astimezone(ZoneInfo("Asia/Novosibirsk")).date()
    count = 0
    for e in registry["entries"]:
        if e.get("status") == "archive" or not e.get("expires"):
            continue
        try:
            expiry = dt.date.fromisoformat(e["expires"])
        except ValueError:
            continue
        days = (expiry - today).days
        milestone = str(days) if days in registry.get("reminderDays", [7, 3, 1, 0]) else "overdue" if -7 <= days < 0 else None
        key = "telegram:" + e["id"] + ":" + e["expires"] + ":" + str(milestone)
        if milestone is None or key in sent:
            continue
        text = "⏳ " + ("Срок акции истек" if days < 0 else "Сегодня заканчивается акция" if days == 0 else "До окончания акции: " + str(days) + " дн.")
        text += "\n\n" + e.get("description", "Акция")[:1500]
        text += "\nURL: " + "\n".join(filter(None, [e.get("ru"), e.get("kz")]))
        text += "\nОкончание: " + e["expires"] + "\nОтветственный: " + (e.get("owner") or "не указан")
        text += "\n\nПроверь продление акции или необходимость редиректа.\nРеестр: https://tanchikpet.github.io/fit-service/registry.html"
        try:
            api(token, "sendMessage", {"chat_id": chat, "text": text[:4000], "link_preview_options": {"is_disabled": True}})
        except RuntimeError:
            # Return successful deliveries so they are not resent after a partial failure.
            return sent, "Ошибка Telegram после отправки " + str(count) + " напоминаний. Повторная попытка — при следующей проверке."
        sent[key] = now
        count += 1
    return sent, "Telegram подключен: @fit_requests_notify_bot. Новых напоминаний отправлено: " + str(count)
