"""Tests for mochahost-dns.py against a fake cPanel UAPI.

    python3 -m unittest scripts/deploy/test_mochahost_dns.py
"""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sys
import threading
import unittest
import urllib.parse
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("dns", Path(__file__).with_name("mochahost-dns.py"))
dns = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dns  # dataclasses look their module up here
spec.loader.exec_module(dns)

DOMAIN = "example.ca"
MOCHA = "203.0.113.10"
VPS = "198.51.100.20"


def standard_zone():
    """What a fresh cPanel account's zone looks like (abridged)."""
    d = DOMAIN + "."
    return [
        ("SOA", d, ["ns1.mochahost.com.", "admin.example.ca.", "2026100501", "3600", "1800", "1209600", "86400"]),
        ("NS", d, ["ns1.mochahost.com."]),
        ("NS", d, ["ns2.mochahost.com."]),
        ("A", d, [MOCHA]),
        ("AAAA", d, ["2001:db8::10"]),
        ("MX", d, ["0", d]),
        ("CNAME", "mail." + d, [d]),
        ("CNAME", "www." + d, [d]),
        ("CNAME", "ftp." + d, [d]),
        ("A", "webmail." + d, [MOCHA]),
        ("A", "cpanel." + d, [MOCHA]),
        ("CNAME", "autodiscover." + d, [d]),
        ("TXT", d, ["v=spf1 +a +mx ~all"]),
        ("TXT", "default._domainkey." + d, ["v=DKIM1; k=rsa; p=MIIB..."]),
        ("TXT", "_dmarc." + d, ["v=DMARC1; p=none"]),
        ("CAA", d, ["0", "issue", "letsencrypt.org"]),
    ]


class FakeCpanel:
    def __init__(self, records):
        self.lines = {}
        self.next_index = 10
        for rtype, name, data in records:
            self._add({"record_type": rtype, "dname": name, "ttl": 14400, "data": data})
        self.routing = "auto"
        self.calls = []

    def _add(self, rec):
        self.lines[self.next_index] = rec
        self.next_index += 2

    @property
    def serial(self):
        return next(r["data"][2] for r in self.lines.values() if r["record_type"] == "SOA")

    def parse_zone(self):
        out = [{"type": "control", "line_index": 0, "text_b64": base64.b64encode(b"$TTL 14400").decode()}]
        for idx, r in sorted(self.lines.items()):
            out.append({
                "type": "record", "line_index": idx, "record_type": r["record_type"], "ttl": r["ttl"],
                "dname_b64": base64.b64encode(r["dname"].encode()).decode(),
                "data_b64": [base64.b64encode(x.encode()).decode() for x in r["data"]],
            })
        return out

    def mass_edit(self, form):
        if form["serial"][0] != self.serial:
            return 0, ["serial mismatch"]
        for idx in form.get("remove", []):
            del self.lines[int(idx)]
        for raw in form.get("edit", []):
            e = json.loads(raw)
            idx = e.pop("line_index")
            assert idx in self.lines, idx
            self.lines[idx] = e
        for raw in form.get("add", []):
            self._add(json.loads(raw))
        soa = next(r for r in self.lines.values() if r["record_type"] == "SOA")
        soa["data"][2] = str(int(soa["data"][2]) + 1)
        return 1, None

    def serve(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                if self.headers.get("Authorization") != "cpanel alice:tok":
                    self.send_response(401); self.end_headers(); return
                form = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
                fn = self.path.rsplit("/", 2)[-2:]
                fake.calls.append("::".join(fn))
                status, errors, data = 1, None, None
                if fn == ["DNS", "parse_zone"]:
                    data = fake.parse_zone()
                elif fn == ["DNS", "mass_edit_zone"]:
                    status, errors = fake.mass_edit(form)
                elif fn == ["Email", "set_always_accept"]:
                    fake.routing = form["mxcheck"][0]
                body = json.dumps({"status": status, "errors": errors, "data": data}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(body)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def get(self, name, rtype):
        return [r["data"] for r in self.lines.values()
                if r["record_type"] == rtype and dns.fqdn(r["dname"], DOMAIN) == name]


class DnsPhases(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCpanel(standard_zone())
        self.server = self.fake.serve()
        self.env = {
            "CPANEL_HOST": f"http://127.0.0.1:{self.server.server_port}", "CPANEL_USER": "alice",
            "CPANEL_TOKEN": "tok", "DOMAIN": DOMAIN, "SERVER_IP": VPS,
        }

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def run_mode(self, mode):
        old = dict(os.environ)
        os.environ.update({**self.env, "MODE": mode})
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                dns.main()
            code = 0
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
            out.write(str(e.code))
        finally:
            os.environ.clear(); os.environ.update(old)
        return code, out.getvalue()

    def test_plan_writes_nothing(self):
        before = json.dumps(self.fake.lines, sort_keys=True)
        code, out = self.run_mode("plan")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.dumps(self.fake.lines, sort_keys=True), before)
        self.assertNotIn("DNS::mass_edit_zone", self.fake.calls)
        self.assertIn(f"MochaHost IP (mail stays here): {MOCHA}", out)
        self.assertNotIn("tok", out)

    def test_web_is_refused_before_email(self):
        code, out = self.run_mode("web")
        self.assertNotEqual(code, 0)
        self.assertIn("Run the email phase first", out)
        self.assertEqual(self.fake.get(DOMAIN, "A"), [[MOCHA]])

    def test_email_then_web_moves_the_site_and_keeps_mail(self):
        code, out = self.run_mode("email")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fake.get(f"mail.{DOMAIN}", "A"), [[MOCHA]])
        self.assertEqual(self.fake.get(f"mail.{DOMAIN}", "CNAME"), [])
        self.assertEqual(self.fake.get(f"ftp.{DOMAIN}", "A"), [[MOCHA]])
        self.assertEqual(self.fake.get(f"autodiscover.{DOMAIN}", "A"), [[MOCHA]])
        self.assertEqual(self.fake.get(DOMAIN, "MX"), [["0", f"mail.{DOMAIN}."]])
        # SPF keeps authorising MochaHost, including the IPv6 address the
        # bare domain's AAAA gave it, which the web phase removes.
        self.assertEqual(self.fake.get(DOMAIN, "TXT")[0], [f"v=spf1 +a +mx +ip4:{MOCHA} +ip6:2001:db8::10 ~all"])
        self.assertEqual(self.fake.routing, "local")
        # The website has not moved yet.
        self.assertEqual(self.fake.get(DOMAIN, "A"), [[MOCHA]])

        code, out = self.run_mode("web")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fake.get(DOMAIN, "A"), [[VPS]])
        self.assertEqual(self.fake.get(f"www.{DOMAIN}", "A"), [[VPS]])
        self.assertEqual(self.fake.get(f"www.{DOMAIN}", "CNAME"), [])
        self.assertEqual(self.fake.get(DOMAIN, "AAAA"), [])
        # Mail and the panel still reach MochaHost; DKIM/DMARC untouched.
        self.assertEqual(self.fake.get(f"mail.{DOMAIN}", "A"), [[MOCHA]])
        self.assertEqual(self.fake.get(f"webmail.{DOMAIN}", "A"), [[MOCHA]])
        self.assertEqual(self.fake.get(f"_dmarc.{DOMAIN}", "TXT"), [["v=DMARC1; p=none"]])
        self.assertEqual(self.fake.get(f"default._domainkey.{DOMAIN}", "TXT"), [["v=DKIM1; k=rsa; p=MIIB..."]])

    def test_every_phase_is_idempotent(self):
        for mode in ("email", "web", "email", "web", "plan"):
            code, out = self.run_mode(mode)
            self.assertEqual(code, 0, f"{mode}: {out}")
        # After the move, MochaHost's IP is still known from the mail record.
        self.assertIn(f"MochaHost IP (mail stays here): {MOCHA}", out)
        self.assertIn("nothing to change", out)

    def test_bad_token_fails_without_printing_it(self):
        self.env["CPANEL_TOKEN"] = "wrong-secret-token"
        code, out = self.run_mode("plan")
        self.assertNotEqual(code, 0)
        self.assertIn("HTTP 401", out)
        self.assertNotIn("wrong-secret-token", out)


class ZoneVariants(DnsPhases):
    """Real zones differ from cPanel's template; each case below is one."""

    def zone_with(self, *extra, drop=()):
        records = [r for r in standard_zone() if (r[0], r[1]) not in drop] + list(extra)
        self.server.shutdown(); self.server.server_close()
        self.fake = FakeCpanel(records)
        self.server = self.fake.serve()
        self.env["CPANEL_HOST"] = f"http://127.0.0.1:{self.server.server_port}"

    def test_mail_with_only_a_txt_record_still_gets_an_address(self):
        d = DOMAIN + "."
        self.zone_with(("TXT", "mail." + d, ["note"]), drop={("CNAME", "mail." + d)})
        self.assertEqual(self.run_mode("email")[0], 0)
        self.assertEqual(self.fake.get(f"mail.{DOMAIN}", "A"), [[MOCHA]])

    def test_mail_alias_to_the_mochahost_server_is_kept_and_web_allowed(self):
        d = DOMAIN + "."
        self.zone_with(("CNAME", "mail." + d, ["server123.mochahost.com."]), drop={("CNAME", "mail." + d)})
        self.assertEqual(self.run_mode("email")[0], 0)
        self.assertEqual(self.fake.get(f"mail.{DOMAIN}", "CNAME"), [["server123.mochahost.com."]])
        code, out = self.run_mode("web")
        self.assertEqual(code, 0, out)

    def test_secondary_mx_and_srv_records(self):
        d = DOMAIN + "."
        self.zone_with(("MX", d, ["10", "mx2.mochahost.com."]),
                       ("SRV", "_caldavs._tcp." + d, ["0", "0", "2080", d]))
        self.assertEqual(self.run_mode("email")[0], 0)
        self.assertIn(["10", "mx2.mochahost.com."], self.fake.get(DOMAIN, "MX"))
        self.assertIn(["0", f"mail.{DOMAIN}."], self.fake.get(DOMAIN, "MX"))
        self.assertEqual(self.fake.get(f"_caldavs._tcp.{DOMAIN}", "SRV"), [["0", "0", "2080", f"mail.{DOMAIN}."]])

    def test_web_is_refused_while_any_email_change_is_outstanding(self):
        self.assertEqual(self.run_mode("email")[0], 0)
        # Someone re-adds an alias of the website by hand.
        self.fake._add({"record_type": "CNAME", "dname": f"webdisk.{DOMAIN}.", "ttl": 14400, "data": [DOMAIN + "."]})
        code, out = self.run_mode("web")
        self.assertNotEqual(code, 0)
        self.assertIn("webdisk", out)
        self.assertEqual(self.fake.get(DOMAIN, "A"), [[MOCHA]])

    def test_a_host_name_for_the_vps_is_resolved(self):
        self.env["SERVER_IP"] = "localhost"
        code, out = self.run_mode("plan")
        self.assertEqual(code, 0, out)
        self.assertIn("-> 127.0.0.1", out)


class Spf(unittest.TestCase):
    def test_adds_ip_only_when_spf_relies_on_a(self):
        self.assertEqual(dns.spf_with_ip("v=spf1 +a +mx ~all", MOCHA), f"v=spf1 +a +mx +ip4:{MOCHA} ~all")
        self.assertEqual(dns.spf_with_ip("v=spf1 a -all", MOCHA), f"v=spf1 a +ip4:{MOCHA} -all")
        self.assertIsNone(dns.spf_with_ip(f"v=spf1 +a +ip4:{MOCHA} ~all", MOCHA))
        self.assertIsNone(dns.spf_with_ip("v=spf1 +mx include:_spf.mochahost.com ~all", MOCHA))
        self.assertIsNone(dns.spf_with_ip("google-site-verification=abc", MOCHA))

    def test_every_form_of_a_on_the_bare_domain(self):
        for mech in ("a", "+a", "a/24", f"a:{DOMAIN}", f"+a:{DOMAIN}/24"):
            self.assertEqual(
                dns.spf_with_ip(f"v=spf1 {mech} ~all", MOCHA, DOMAIN),
                f"v=spf1 {mech} +ip4:{MOCHA} ~all", mech)
        # a on another host, or a failing/neutral qualifier, does not authorise MochaHost.
        for mech in ("a:other.example", "-a", "~a", "?a"):
            self.assertIsNone(dns.spf_with_ip(f"v=spf1 {mech} ~all", MOCHA, DOMAIN), mech)

    def test_keeps_mochahost_ipv6(self):
        self.assertEqual(
            dns.spf_with_ip("v=spf1 +a ~all", MOCHA, DOMAIN, ("2001:db8::10",)),
            f"v=spf1 +a +ip4:{MOCHA} +ip6:2001:db8::10 ~all")


if __name__ == "__main__":
    unittest.main()
