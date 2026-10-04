import re
import unicodedata


def slugify(text, sep="-"):
    """Return a lowercase ASCII slug of text, with words joined by sep."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = text.lower()
    text = re.sub(r"[^a-z0-9]", sep, text)
    return text.strip()
