#!/usr/bin/env python3
"""Repair a private SSH key that went through copy and paste.

    python3 repair-ssh-key.py KEYFILE SECRET_NAME

Keys pasted into a GitHub secret from a web page (Coolify, a password
manager, an email) often arrive with Windows line endings, with their line
breaks turned into spaces or dropped, or with page text around them. ssh
then refuses the key with "error in libcrypto". This rewrites KEYFILE as a
clean key block and prints what it changed.

The output names the problem, never the key: the Actions log is public.
Exit status 0 when KEYFILE now holds a key block, 2 when it cannot.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BLOCK = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", re.S)
PUBLIC = re.compile(r"\s*(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-)")


def repair(text: str) -> tuple[str, list[str]]:
    """Return (clean key block, notes). Raises ValueError with a reason."""
    notes: list[str] = []
    if "\r" in text:
        text = text.replace("\r", "")
        notes.append("removed Windows line endings")
    match = BLOCK.search(text)
    if not match:
        if PUBLIC.match(text):
            raise ValueError(
                "holds a public key (it starts with ssh-...); it needs the private key, "
                "the block from -----BEGIN to -----END"
            )
        if "-----BEGIN" in text:
            raise ValueError("has a -----BEGIN line but no matching -----END line: the copy was cut off")
        if not text.strip():
            raise ValueError("is empty")
        raise ValueError("does not contain a -----BEGIN ... PRIVATE KEY----- block")
    kind, body = match.group(1), match.group(2)
    if "PRIVATE KEY" not in kind:
        raise ValueError(f"holds a {kind} block, not a private key")
    if text[: match.start()].strip() or text[match.end():].strip():
        notes.append("ignored text before or after the key")
    if ":" in body:
        # An old-style PEM key with headers (e.g. Proc-Type: 4,ENCRYPTED).
        # Its layout matters; keep it as it is.
        return match.group(0) + "\n", notes
    compact = re.sub(r"\s+", "", body)
    if not compact:
        raise ValueError("has an empty key block")
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
        raise ValueError(
            "contains characters a key never has (for example dots or asterisks "
            "from a hidden or shortened field)"
        )
    original_lines = [line for line in body.split("\n") if line.strip()]
    if len(original_lines) <= 1 and len(compact) > 100:
        notes.append("restored the line breaks")
    elif any(line != line.strip() for line in original_lines):
        notes.append("removed spaces inside the key")
    lines = [compact[i : i + 64] for i in range(0, len(compact), 64)]
    return f"-----BEGIN {kind}-----\n" + "\n".join(lines) + f"\n-----END {kind}-----\n", notes


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: repair-ssh-key.py KEYFILE SECRET_NAME", file=sys.stderr)
        return 2
    path, name = Path(argv[1]), argv[2]
    try:
        # newline="" keeps \r so the note can name Windows line endings.
        with open(path, encoding="utf-8", errors="replace", newline="") as handle:
            clean, notes = repair(handle.read())
    except ValueError as reason:
        print(f"{name} {reason}.", file=sys.stderr)
        return 2
    path.write_text(clean, encoding="utf-8")
    if notes:
        print(f"{name}: {', '.join(notes)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
