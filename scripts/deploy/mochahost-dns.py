#!/usr/bin/env python3
"""Point a MochaHost (cPanel) domain at the VPS without moving its email.

On cPanel's standard zone the MX record names the bare domain and `mail` is
an alias for it, so moving the website's A record would move email too. This
runs in phases:

  plan   read the zone and print what each phase would change (no writes)
  email  give mail its own records first: `mail` (and webmail, cpanel, ...)
         become A records to MochaHost's IP, MX points at mail.<domain>,
         SPF keeps authorising MochaHost, mail routing stays local
  web    point the bare domain and www at the VPS and drop their AAAA
         records; refused until the email phase is in place

Every phase is idempotent. Uses cPanel UAPI (DNS::parse_zone,
DNS::mass_edit_zone, Email::set_always_accept) with an API token.

Environment: CPANEL_HOST, CPANEL_USER, CPANEL_TOKEN, DOMAIN, SERVER_IP,
MODE. Prints DNS records (public data) and never the token.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

# Names that cPanel aliases to the bare domain and that must keep pointing
# at MochaHost (mail clients, webmail, the control panel). www is the website.
KEEP_ON_MOCHAHOST = (
    "mail", "webmail", "cpanel", "webdisk", "ftp", "autodiscover", "autoconfig",
    "cpcalendars", "cpcontacts", "whm",
)


@dataclass
class Record:
    line_index: int
    name: str            # fully qualified, lower case, no trailing dot
    rtype: str
    ttl: int
    data: list[str]
    raw_dname: str = ""  # exactly as the zone has it


@dataclass
class Zone:
    domain: str
    serial: str
    records: list[Record]

    def find(self, name: str, rtype: str | None = None) -> list[Record]:
        return [r for r in self.records if r.name == name and (rtype is None or r.rtype == rtype)]


@dataclass
class Change:
    kind: str                     # add | edit | remove
    description: str
    record: dict = field(default_factory=dict)
    line_index: int | None = None


def fqdn(name: str, domain: str) -> str:
    name = name.strip().lower()
    if name in ("", "@"):
        return domain
    if name.endswith("."):
        return name[:-1]
    if name == domain or name.endswith("." + domain):
        return name
    return f"{name}.{domain}"


def parse_zone(payload: dict, domain: str) -> Zone:
    records: list[Record] = []
    serial = ""
    for item in payload.get("data") or []:
        if item.get("type") != "record":
            continue
        raw = base64.b64decode(item.get("dname_b64", "")).decode()
        data = [base64.b64decode(d).decode() for d in item.get("data_b64") or []]
        rec = Record(
            line_index=int(item["line_index"]),
            name=fqdn(raw, domain),
            rtype=str(item.get("record_type", "")).upper(),
            ttl=int(item.get("ttl") or 14400),
            data=data,
            raw_dname=raw,
        )
        if rec.rtype == "SOA" and len(data) >= 3:
            serial = data[2]
        records.append(rec)
    if not serial:
        raise SystemExit("The zone has no SOA serial; cPanel's answer was not a zone.")
    return Zone(domain=domain, serial=serial, records=records)


def mochahost_ip(zone: Zone, server_ip: str) -> str:
    """MochaHost's web/mail IP: the bare domain's A record before the move,
    or the mail A record after it."""
    for rec in zone.find(zone.domain, "A"):
        if rec.data and rec.data[0] != server_ip:
            return rec.data[0]
    for rec in zone.find(f"mail.{zone.domain}", "A"):
        if rec.data and rec.data[0] != server_ip:
            return rec.data[0]
    raise SystemExit(
        "Cannot tell MochaHost's IP: the bare domain already points at the VPS and there is "
        "no mail A record. Add `A mail.<domain> -> <MochaHost IP>` in Zone Editor, then rerun."
    )


def a_record(name: str, ttl: int, ip: str) -> dict:
    return {"dname": f"{name}.", "ttl": ttl, "record_type": "A", "data": [ip]}


def spf_with_ip(value: str, ip: str, domain: str = "", ip6: tuple[str, ...] = ()) -> str | None:
    """SPF that still authorises MochaHost (`ip`, and its IPv6 addresses
    `ip6`) after the bare domain moves, or None if no change is needed.

    Only an `a` mechanism that resolves the bare domain loses MochaHost when
    it moves: `a`, `+a`, `a/24`, `a:<domain>`, `+a:<domain>/24`."""
    tokens = value.split()
    if not tokens or tokens[0].lower() != "v=spf1":
        return None
    apex = re.escape(domain.lower()) if domain else None
    pattern = rf"\+?a(:{apex}\.?)?(/\d+)?(//\d+)?" if apex else r"\+?a(/\d+)?(//\d+)?"
    relies_on_a = any(re.fullmatch(pattern, t.lower()) for t in tokens[1:])
    if not relies_on_a:
        return None
    present = {t.lower().lstrip("+") for t in tokens[1:]}
    wanted = [f"ip4:{ip}"] + [f"ip6:{a}" for a in ip6]
    missing = [w for w in wanted if w.lower() not in present]
    if not missing:
        return None
    insert_at = len(tokens) - 1 if re.fullmatch(r"[-~?+]?all", tokens[-1].lower()) else len(tokens)
    tokens[insert_at:insert_at] = [f"+{w}" for w in missing]
    return " ".join(tokens)


def txt_chunks(value: str) -> list[str]:
    return [value[i:i + 255] for i in range(0, len(value), 255)] or [""]


def email_phase(zone: Zone, server_ip: str) -> list[Change]:
    d = zone.domain
    ip = mochahost_ip(zone, server_ip)
    changes: list[Change] = []
    default_ttl = next((r.ttl for r in zone.find(d, "A")), 14400)

    for label in KEEP_ON_MOCHAHOST:
        name = f"{label}.{d}"
        cnames = [r for r in zone.find(name, "CNAME") if r.data and fqdn(r.data[0], d) == d]
        a_recs = zone.find(name, "A")
        for r in cnames:
            changes.append(Change("remove", f"{name} CNAME -> {d} (alias of the website)", line_index=r.line_index))
        if cnames and not a_recs:
            changes.append(Change("add", f"{name} A -> {ip} (stays on MochaHost)", a_record(name, cnames[0].ttl, ip)))
        elif label == "mail" and not a_recs and not any(r.rtype in ("A", "CNAME") for r in zone.find(name)):
            changes.append(Change("add", f"{name} A -> {ip} (mail gets its own address)", a_record(name, default_ttl, ip)))
        for r in a_recs:
            if r.data and r.data[0] == server_ip:
                changes.append(Change(
                    "edit", f"{name} A {server_ip} -> {ip} (mail stays on MochaHost)",
                    {**a_record(name, r.ttl, ip), "dname": r.raw_dname}, r.line_index))

    for r in zone.find(d, "MX"):
        if len(r.data) >= 2 and fqdn(r.data[1], d) == d:
            changes.append(Change(
                "edit", f"{d} MX {r.data[0]} {d} -> mail.{d}",
                {"dname": r.raw_dname, "ttl": r.ttl, "record_type": "MX", "data": [r.data[0], f"mail.{d}."]},
                r.line_index))

    # cPanel's calendar/contacts SRV records (_caldav._tcp, ...) may target
    # the bare domain; keep them on MochaHost with mail.
    for r in zone.records:
        if r.rtype == "SRV" and len(r.data) >= 4 and fqdn(r.data[3], d) == d:
            changes.append(Change(
                "edit", f"{r.name} SRV -> mail.{d} (stays on MochaHost)",
                {"dname": r.raw_dname, "ttl": r.ttl, "record_type": "SRV",
                 "data": [r.data[0], r.data[1], r.data[2], f"mail.{d}."]},
                r.line_index))

    apex_v6 = tuple(r.data[0] for r in zone.find(d, "AAAA") if r.data)
    for r in zone.find(d, "TXT"):
        value = "".join(r.data)
        new = spf_with_ip(value, ip, d, apex_v6)
        if new:
            changes.append(Change(
                "edit", f"{d} SPF '{value}' -> '{new}'",
                {"dname": r.raw_dname, "ttl": r.ttl, "record_type": "TXT", "data": txt_chunks(new)},
                r.line_index))
    return changes


def email_phase_done(zone: Zone, server_ip: str) -> list[str]:
    """Why moving the website now would take email with it (empty = safe)."""
    d = zone.domain
    problems = []
    for r in zone.find(d, "MX"):
        if len(r.data) < 2:
            problems.append(f"an MX record for {d} has an unexpected shape")  # fail closed
        elif fqdn(r.data[1], d) == d:
            problems.append(f"MX still names {d}")
    mail_a = zone.find(f"mail.{d}", "A")
    mail_cname = [r for r in zone.find(f"mail.{d}", "CNAME") if r.data]
    if any(fqdn(r.data[0], d) == d for r in mail_cname):
        problems.append(f"mail.{d} is still an alias of {d}")
    elif not mail_a and not mail_cname and any(
        len(r.data) >= 2 and fqdn(r.data[1], d) == f"mail.{d}" for r in zone.find(d, "MX")
    ):
        problems.append(f"mail.{d} has no address record")
    if any(r.data and r.data[0] == server_ip for r in mail_a):
        problems.append(f"mail.{d} points at the VPS")
    return problems


def web_phase(zone: Zone, server_ip: str) -> list[Change]:
    d = zone.domain
    changes: list[Change] = []
    apex_a = zone.find(d, "A")
    if not apex_a:
        changes.append(Change("add", f"{d} A -> {server_ip}", a_record(d, 14400, server_ip)))
    for r in apex_a:
        if r.data and r.data[0] != server_ip:
            changes.append(Change("edit", f"{d} A {r.data[0]} -> {server_ip}",
                                  {**a_record(d, r.ttl, server_ip), "dname": r.raw_dname}, r.line_index))
    www = f"www.{d}"
    www_a = zone.find(www, "A")
    for r in zone.find(www, "CNAME"):
        changes.append(Change("remove", f"{www} CNAME -> {r.data[0] if r.data else '?'}", line_index=r.line_index))
    if not www_a:
        ttl = next((r.ttl for r in zone.find(www)), 14400)
        changes.append(Change("add", f"{www} A -> {server_ip}", a_record(www, ttl, server_ip)))
    for r in www_a:
        if r.data and r.data[0] != server_ip:
            changes.append(Change("edit", f"{www} A {r.data[0]} -> {server_ip}",
                                  {**a_record(www, r.ttl, server_ip), "dname": r.raw_dname}, r.line_index))
    for name in (d, www):
        for r in zone.find(name, "AAAA"):
            changes.append(Change("remove", f"{name} AAAA {r.data[0] if r.data else ''} (would still reach MochaHost)",
                                  line_index=r.line_index))
    return changes


def resolve_ipv4(value: str) -> str:
    """The VPS address as IPv4: accept an IP or a hostname with one A record."""
    value = value.strip()
    try:
        addr = ipaddress.ip_address(value)
        if addr.version == 4:
            return value
        raise SystemExit("The VPS address must be IPv4 for the A records.")
    except ValueError:
        pass
    import socket
    try:
        found = sorted({ai[4][0] for ai in socket.getaddrinfo(value, None, socket.AF_INET)})
    except socket.gaierror:
        raise SystemExit("The VPS address (CONTABO_SSH_HOST) is neither an IPv4 address nor a resolvable host.") from None
    if len(found) != 1:
        raise SystemExit("The VPS host name resolves to several addresses; put the IPv4 address in CONTABO_SSH_HOST.")
    return found[0]


class Cpanel:
    def __init__(self, host: str, user: str, token: str):
        # A bare host means cPanel's standard HTTPS port; a full URL (used by
        # the tests' fake server) is taken as is.
        self.base = f"{host.rstrip('/')}/execute" if "://" in host else f"https://{host}:2083/execute"
        self.auth = f"cpanel {user}:{token}"
        self.ctx = ssl.create_default_context()

    def call(self, module: str, function: str, params: list[tuple[str, str]]) -> dict:
        body = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(f"{self.base}/{module}/{function}", data=body, method="POST")
        req.add_header("Authorization", self.auth)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=60) as resp:
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            raise SystemExit(f"cPanel {module}::{function} returned HTTP {e.code}. Check the API token and user.") from None
        if not payload.get("status"):
            errors = "; ".join(payload.get("errors") or ["unknown error"])
            raise SystemExit(f"cPanel {module}::{function} failed: {errors}")
        return payload


def load_zone(api: Cpanel, domain: str) -> Zone:
    return parse_zone(api.call("DNS", "parse_zone", [("zone", domain)]), domain)


def apply(api: Cpanel, zone: Zone, changes: list[Change]) -> None:
    params: list[tuple[str, str]] = [("zone", zone.domain), ("serial", zone.serial)]
    for c in changes:
        if c.kind == "add":
            params.append(("add", json.dumps(c.record)))
        elif c.kind == "edit":
            params.append(("edit", json.dumps({**c.record, "line_index": c.line_index})))
        elif c.kind == "remove":
            params.append(("remove", str(c.line_index)))
    api.call("DNS", "mass_edit_zone", params)


def show(title: str, changes: list[Change]) -> None:
    print(f"\n{title}:")
    if not changes:
        print("  nothing to change")
    for c in changes:
        print(f"  {c.kind:6} {c.description}")


def show_zone(zone: Zone) -> None:
    print(f"Zone {zone.domain} (serial {zone.serial}):")
    interesting = {"A", "AAAA", "CNAME", "MX", "TXT", "NS", "CAA", "SRV"}
    for r in zone.records:
        if r.rtype in interesting:
            print(f"  {r.name:40} {r.ttl:>6} {r.rtype:5} {' '.join(r.data)[:120]}")


def main() -> None:
    env = os.environ
    mode = env.get("MODE", "plan")
    domain = env.get("DOMAIN", "").strip().lower().removeprefix("www.").rstrip(".")
    server_ip = env.get("SERVER_IP", "").strip()
    if mode not in ("plan", "email", "web"):
        raise SystemExit("MODE must be plan, email or web.")
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", domain):
        raise SystemExit("DOMAIN is not a domain name.")
    server_ip = resolve_ipv4(server_ip)
    for name in ("CPANEL_HOST", "CPANEL_USER", "CPANEL_TOKEN"):
        if not env.get(name):
            raise SystemExit(f"Missing required secret name: MOCHAHOST_{name}")

    api = Cpanel(env["CPANEL_HOST"], env["CPANEL_USER"], env["CPANEL_TOKEN"])
    zone = load_zone(api, domain)
    show_zone(zone)

    email_changes = email_phase(zone, server_ip)
    if mode == "plan":
        print(f"\nMochaHost IP (mail stays here): {mochahost_ip(zone, server_ip)}")
        show("Email phase would change", email_changes)
        # Show the web phase as it will look once the email phase is in.
        show("Web phase would change (after the email phase)", web_phase(zone, server_ip))
        return

    if mode == "email":
        show("Email phase", email_changes)
        if email_changes:
            apply(api, zone, email_changes)
            zone = load_zone(api, domain)
        try:
            api.call("Email", "set_always_accept", [("domain", domain), ("mxcheck", "local")])
            print("Mail routing: Local Mail Exchanger (MochaHost keeps delivering your mail).")
        except SystemExit as e:
            print(f"WARNING: could not set mail routing automatically ({e}). In cPanel > Email Routing choose Local Mail Exchanger.")
        remaining = email_phase(zone, server_ip)
        problems = email_phase_done(zone, server_ip)
        if remaining or problems:
            show("Still not applied", remaining)
            for p in problems:
                print(f"  problem {p}")
            raise SystemExit(1)
        print("\nEmail phase is in place.")
        return

    problems = email_phase_done(zone, server_ip) + [c.description for c in email_changes]
    if problems:
        raise SystemExit("Run the email phase first: " + "; ".join(problems))
    web_changes = web_phase(zone, server_ip)
    show("Web phase", web_changes)
    if web_changes:
        apply(api, zone, web_changes)
        zone = load_zone(api, domain)
    remaining = web_phase(zone, server_ip)
    if remaining:
        show("Still not applied", remaining)
        raise SystemExit(1)
    print(f"\nWeb phase is in place: {domain} and www.{domain} point at {server_ip}.")


if __name__ == "__main__":
    main()
