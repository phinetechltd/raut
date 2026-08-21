"""
Checks the store listing copy against Play's field limits.

Play truncates silently in some places and rejects in others, and a description
that is four characters over is not something you want to discover after
uploading. Counts are on the exact text inside each fenced block of
store-listing.md.

    python check-listing.py
"""
import pathlib
import re
import sys

LIMITS = {
    "App name": 30,
    "Short description": 80,
    "Full description": 4000,
}

SRC = pathlib.Path(__file__).with_name("play-store-listing.md")


def blocks(md: str):
    """Yield (heading, first fenced block) for each '## ' section."""
    for chunk in re.split(r"^## ", md, flags=re.M)[1:]:
        heading = chunk.splitlines()[0].strip()
        # strip the "(80 max)" suffix so it matches LIMITS
        name = re.sub(r"\s*\(\d+\s*max\)\s*$", "", heading)
        fence = re.search(r"```\n(.*?)\n```", chunk, flags=re.S)
        if fence:
            yield name, fence.group(1)


def main() -> int:
    md = SRC.read_text(encoding="utf-8")
    failed = False
    for name, text in blocks(md):
        limit = LIMITS.get(name)
        if limit is None:
            continue
        n = len(text)
        ok = n <= limit
        failed |= not ok
        flag = "OK  " if ok else "OVER"
        print(f"  [{flag}] {name:20} {n:>5} / {limit}   ({limit - n:+d})")

    print("\n" + ("All fields fit." if not failed else "SOME FIELDS ARE OVER THE LIMIT."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
