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
import unicodedata
from pathlib import Path

# A BEGIN/END block whose body does not run into another BEGIN, so a cut-off
# first paste does not swallow a complete second one.
BLOCK = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----((?:(?!-----BEGIN ).)*?)-----END \1-----", re.S)
PUBLIC = re.compile(r"\s*(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-)")


def normalise(text: str, notes: list[str]) -> str:
    """Undo what web pages, editors and JSON do to text, noting each change."""
    if "\r" in text:
        text = text.replace("\r", "")
        notes.append("removed Windows line endings")
    if "\\n" in text:
        # A key copied out of JSON or a .env file. Backslashes never occur in
        # a key, so the two-character pair can only be an escaped line break.
        text = text.replace("\\r\\n", "\n").replace("\\n", "\n")
        notes.append("turned \\n escapes into line breaks")
    invisible = [c for c in text if unicodedata.category(c) == "Cf"]
    if invisible:
        # Zero-width spaces, word joiners, soft hyphens, byte order marks.
        text = "".join(c for c in text if unicodedata.category(c) != "Cf")
        notes.append("removed invisible characters")
    if any(c.isspace() and c not in " \t\n" for c in text):
        # No-break and other Unicode spaces, e.g. in the BEGIN/END lines.
        text = "".join(" " if c.isspace() and c != "\n" else c for c in text)
        notes.append("replaced special spaces")
    return text


def repair(text: str) -> tuple[str, list[str]]:
    """Return (clean key block, notes). Raises ValueError with a reason."""
    notes: list[str] = []
    text = normalise(text, notes)
    blocks = list(BLOCK.finditer(text))
    match = next((m for m in blocks if "PRIVATE KEY" in m.group(1)), None)
    if not match:
        if blocks:
            raise ValueError(f"holds a {blocks[0].group(1)} block, not a private key")
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
    if kind == "ENCRYPTED PRIVATE KEY" or re.search(r"Proc-Type:\s*4,ENCRYPTED", body):
        raise ValueError("is protected by a passphrase; the workflows need a key without one")
    if text[: match.start()].strip() or text[match.end():].strip():
        notes.append("ignored text before or after the key")
    if ":" in body:
        # An old-style PEM key with headers. Its layout matters; keep it.
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
