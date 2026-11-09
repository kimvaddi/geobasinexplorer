"""Deterministic checks that run before and beside the validator model, ported from version 1
(services/api/src/validate.ts numbersIn, numberSupported and deterministicCheck), so a number the evidence doesn't state
can never reach a person, whatever a model says about it."""
import re

from .contracts import EVIDENCE_ID, MAX_STATEMENTS, Statement

# A minus sign counts only at the start of a token, so the dash in a range such as "6412-6454" is never read as one.
NUM = re.compile(r"(?<![A-Za-z_\d.,])(?:(?<=[\s(])[-−](?=\d)|^[-−](?=\d))?\d[\d,]*(?:\.\d+)?")
UNIT_AFTER = re.compile(r"^\s?(?:(ft|feet|foot|')|(m|metres?|meters?)(?![A-Za-z])|(°\s?F|degF|deg F|degrees F(?:ahrenheit)?)|(°\s?C|degC|deg C|degrees C(?:elsius)?)|(psi)|(kPa)|(MPa))")
UNITS = ["ft", "m", "F", "C", "psi", "kPa", "MPa"]
CONVERT = {
    ("ft", "m"): lambda x: x * 0.3048, ("m", "ft"): lambda x: x / 0.3048,
    ("F", "C"): lambda x: (x - 32) * 5 / 9, ("C", "F"): lambda x: x * 9 / 5 + 32,
    ("psi", "kPa"): lambda x: x * 6.894757, ("psi", "MPa"): lambda x: x * 0.006894757,
    ("kPa", "psi"): lambda x: x / 6.894757, ("MPa", "psi"): lambda x: x / 0.006894757,
}
ID = re.compile(EVIDENCE_ID)


def numbers_in(text: str) -> list[tuple[str, float, str | None]]:
    out = []
    for m in NUM.finditer(text):
        raw = m.group(0).rstrip(",")
        try:
            value = float(raw.replace(",", "").replace("−", "-"))
        except ValueError:
            continue
        unit = UNIT_AFTER.match(text[m.end():m.end() + 24])
        out.append((raw, value, UNITS[[g is not None for g in unit.groups()].index(True)] if unit else None))
    return out


def number_supported(raw: str, value: float, unit: str | None, evidence: str) -> bool:
    """Stated in the evidence, or given there in another named unit that converts to it at the claim's precision."""
    pool = numbers_in(evidence)
    if any(v == value for _, v, _ in pool):
        return True
    if not unit:
        return False
    decimals = len(raw.split(".")[1]) if "." in raw else 0
    tolerance = 0.5 * 10 ** -decimals + 1e-9
    return any(u and (u, unit) in CONVERT and abs(value - CONVERT[(u, unit)](v)) <= tolerance for _, v, u in pool)


def unsupported_numbers(text: str, evidence: str, titles: list[str] | None = None, pages: list[int] | None = None, question: str = "") -> list[str]:
    """Version 1's deterministicCheck: a statement may point at a cited page ("page 314") or name a cited document, and only
    those exact spans are set aside before every remaining number must be found in the cited evidence. A number in the
    person's own question or hypothesis may also be restated, since repeating it claims nothing from the evidence; the
    validator still judges whether the statement holds."""
    cited_pages = {p for p in pages or [] if p > 0}

    def page_ref(m: re.Match) -> str:
        a, b = int(m.group(2)), m.group(3)
        return " " if a in cited_pages and (b is None or int(b) in cited_pages) else m.group(0)
    t = re.sub(r"\b(pages?|pp?\.)\s*(\d+)(?:\s*(?:[–-]|and|to)\s*(\d+))?", page_ref, text, flags=re.I)
    for title in titles or []:
        for form in {title, re.sub(r"\s*·\s*", " ", title), re.split(r"\s*·\s*", title)[0]}:
            if len(form.strip()) < 4:
                continue
            t = re.sub(r"\s+".join(re.escape(w) for w in form.strip().split()), " ", t, flags=re.I)
    return [raw for raw, value, unit in numbers_in(t) if not number_supported(raw, value, unit, f"{evidence}\n{question}")]


def title_of(label: str) -> str:
    """The document title in a tool's evidence label, such as "Marabooka 1 report, native PDF page 25 (live)"."""
    return re.sub(r",\s*(?:native PDF )?page \d+ \((?:live|packaged snapshot)\)$", "", label).strip()


def clean_statements(statements: list[Statement], allowed: set[str] | None = None, limit: int = MAX_STATEMENTS) -> tuple[list[Statement], list[str]]:
    """Keeps well-formed citations (and, when given, only allowed IDs), drops statements left without one, and caps the
    count. Returns the statements kept and a note for each one dropped."""
    kept, notes = [], []
    for s in statements:
        cites = list(dict.fromkeys(c for c in s.cites if ID.match(c) and (allowed is None or c in allowed)))
        text = s.text.strip()
        if not text or not cites or len(text) > 2000 or re.search(r"(?:https?://|(?:blob|data|javascript):|[?&]sig=)", text, re.I):
            notes.append(f"dropped a statement without a usable citation: {text[:80]}")
            continue
        kept.append(s.model_copy(update={"text": text, "cites": cites[:12]}))
    if len(kept) > limit:
        notes.append(f"kept the first {limit} of {len(kept)} statements")
        kept = kept[:limit]
    return kept, notes
