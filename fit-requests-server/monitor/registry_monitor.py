"""Check public URLs, discover candidates, and send expiry reminders. Stdlib only."""
import http.client
import concurrent.futures
import datetime as dt
import hashlib
import html.parser
import ipaddress
import json
import os
from pathlib import Path
import smtplib
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.message import EmailMessage
from zoneinfo import ZoneInfo

ROOT = Path(os.environ["REGISTRY_WORK_DIR"])
LIMIT = 2_000_000
DOMAINS = ("fitauto.ru", "fitavto.kz", "fitautolab.ru")


def read(name):
    return json.loads((ROOT / "data" / name).read_text())


def write(name, value):
    (ROOT / "data" / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def normalized(url):
    try:
        p = urllib.parse.urlsplit(url.strip())
        if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
            return None
        if any(x in url for x in ("раздел/", "{", "}")):
            return None
        return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", p.query, ""))
    except ValueError:
        return None


def public_target(url):
    url = normalized(url)
    if not url:
        raise ValueError("некорректный адрес")
    p = urllib.parse.urlsplit(url)
    if p.port not in (None, 80, 443):
        raise ValueError("нестандартный порт")
    addresses = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("адрес не является публичным")
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_target(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url):
    # Pin the validated DNS result to the connection to prevent DNS rebinding.
    for redirect in range(9):
        url = public_target(url)
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError("адрес не является публичным")
        ip = addresses[0][4][0]
        cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = cls(parsed.hostname, port, timeout=12)
        connection._create_connection = lambda address, timeout, source_address=None: socket.create_connection((ip, port), timeout, source_address)
        try:
            path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
            connection.request("GET", path, headers={"User-Agent": "FIT-Service-Registry/2.0", "Accept": "text/html,application/xml,application/json,*/*"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
                url = urllib.parse.urljoin(url, response.getheader("Location"))
                continue
            return response.status, url, response.getheader("Content-Type", ""), response.read(LIMIT)
        finally:
            connection.close()
    raise ValueError("слишком много редиректов")


def owned(url):
    try:
        h = (urllib.parse.urlsplit(url).hostname or "").lower()
        return any(h == d or h.endswith("." + d) for d in DOMAINS)
    except ValueError:
        return False


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            v = dict(attrs).get("href", "")
            if v:
                self.urls.append(v)


def check(url, old, expected, now):
    try:
        status, final, content_type, body = fetch(url)
        previous = old.get("finalUrl")
        result = {"status": status, "finalUrl": final, "checkedAt": now, "changed": bool(previous and previous != final), "previousFinalUrl": previous, "expectedMismatch": bool(expected and normalized(expected) != normalized(final))}
        links = []
        if 200 <= status < 300 and "html" in content_type:
            parser = Links()
            parser.feed(body.decode("utf-8", errors="replace"))
            links = [urllib.parse.urljoin(final, x) for x in parser.urls[:400]]
        return url, result, links
    except Exception as e:
        # Preserve the last successful destination across transient failures.
        return url, {"checkedAt": now, "error": str(e)[:250], "finalUrl": old.get("finalUrl"), "changed": False}, []


def sitemap_urls(url, budget, seen=None):
    seen = seen if seen is not None else set()
    if url in seen or len(seen) >= budget:
        return []
    seen.add(url)
    status, _, _, body = fetch(url)
    if status != 200:
        return []
    root = ET.fromstring(body)
    locs = [n.text.strip() for n in root.iter() if n.tag.split("}")[-1] == "loc" and n.text]
    if root.tag.split("}")[-1] == "sitemapindex":
        found = []
        for loc in locs[:8]:
            if owned(loc):
                try:
                    found.extend(sitemap_urls(loc, budget, seen))
                except Exception:
                    continue
        return found
    return locs[:1500]


def discover_certificates(domain):
    url = "https://crt.sh/?q=" + urllib.parse.quote("%." + domain) + "&output=json"
    status, _, _, body = fetch(url)
    if status != 200:
        raise ValueError("HTTP " + str(status))
    names = set()
    for cert in json.loads(body):
        for name in cert.get("name_value", "").splitlines():
            name = name.lower().strip()
            if "*" not in name and name.endswith("." + domain):
                names.add("https://" + name + "/")
    return sorted(names)[:1500]




def main():
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    registry, report, candidates = read("registry.json"), read("registry-checks.json"), read("registry-candidates.json")
    old = report.get("checks", {})
    urls, expected = set(), {}
    for e in registry["entries"]:
        if e.get("isTemplate"):
            continue
        for key, redirect in [("ru", "redirectRu"), ("kz", "redirectKz")]:
            u = normalized(e.get(key, ""))
            if u:
                urls.add(u)
                if e.get(redirect):
                    expected[u] = e[redirect]
    findings, updated, errors = [], dict(old), []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(check, u, old.get(u, {}), expected.get(u), now) for u in sorted(urls)]
        for future in concurrent.futures.as_completed(futures):
            u, c, links = future.result()
            updated[u] = c
            findings.extend((x, "Ссылка со страницы " + u) for x in links)
    for domain in DOMAINS:
        try:
            findings.extend((u, "Карта сайта " + domain) for u in sitemap_urls("https://" + domain + "/sitemap.xml", 8))
        except Exception as e:
            errors.append("Карта сайта " + domain + ": " + str(e)[:150])
        try:
            findings.extend((u, "Публичные сертификаты " + domain) for u in discover_certificates(domain))
        except Exception as e:
            errors.append("Сертификаты " + domain + ": " + str(e)[:150])
    known = {normalized(e.get(k, "")) for e in registry["entries"] for k in ["ru", "kz", "redirectRu", "redirectKz"]}
    items = candidates.get("items", [])
    indexed = {i["url"]: i for i in items}
    for item in items:
        if normalized(item["url"]) in known and item["state"] == "pending":
            item["state"] = "approved"
    added = 0
    for u, source in findings:
        u = normalized(u)
        if not u or not owned(u) or u in known or u in indexed or added >= 1500:
            continue
        parsed = urllib.parse.urlsplit(u)
        # Tracking links and static assets are not separate registry pages.
        if parsed.query or re_asset(parsed.path):
            continue
        item = {"id": "found-" + hashlib.sha256(u.encode()).hexdigest()[:16], "url": u, "source": source, "foundAt": now, "state": "pending"}
        items.append(item)
        indexed[u] = item
        added += 1
    sent = {}
    email_status = "Проверка завершена. Напоминания обрабатывает сервер FIT Requests."
    report.update(checkedAt=now, checks=updated, notifications=sent, discoveryErrors=errors, emailStatus=email_status)
    candidates.update(updatedAt=now, items=items)
    write("registry-checks.json", report)
    write("registry-candidates.json", candidates)
    summary = "Проверено: " + str(len(urls)) + "; новых кандидатов: " + str(added) + ". " + email_status
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary + "\n\n" + "\n".join(errors))


def re_asset(path):
    return path.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".css", ".js", ".pdf", ".zip", ".woff", ".woff2", ".ico", ".xml", ".mp4"))


if __name__ == "__main__":
    main()
