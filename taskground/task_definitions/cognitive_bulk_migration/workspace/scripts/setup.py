#!/usr/bin/env python3
"""Generate the deterministic cognitive_bulk_migration workspace."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SPECS = [
    ("account_id", "Read account_id. Strip surrounding whitespace, lowercase it, and emit it as accountId. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("user_handle", "Read handle. Strip surrounding whitespace, lowercase it, and emit it as userHandle. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("owner_key", "Read owner. Strip surrounding whitespace, lowercase it, and emit it as ownerKey. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("profile_slug", "Read slug. Strip surrounding whitespace, lowercase it, and emit it as profileSlug. Missing or None becomes the empty string. Preserve meta unchanged when present."),

    ("tags", "Read tags_csv as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as tags. Missing or None becomes an empty list. Preserve meta unchanged when present."),
    ("labels", "Read labels_csv as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as labels. Missing or None becomes an empty list. Preserve meta unchanged when present."),
    ("topics", "Read topic_list as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as topics. Missing or None becomes an empty list. Preserve meta unchanged when present."),
    ("scopes", "Read scopes_text as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as scopes. Missing or None becomes an empty list. Preserve meta unchanged when present."),

    ("amount_cents", "Read amount. Convert a base-10 integer string or integer to an integer and emit it as amountCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present."),
    ("fee_cents", "Read fee. Convert a base-10 integer string or integer to an integer and emit it as feeCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present."),
    ("balance_cents", "Read balance. Convert a base-10 integer string or integer to an integer and emit it as balanceCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present."),
    ("tax_cents", "Read tax. Convert a base-10 integer string or integer to an integer and emit it as taxCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present."),

    ("enabled", "Read enabled_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit enabled. Preserve meta unchanged when present."),
    ("archived", "Read archived_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit archived. Preserve meta unchanged when present."),
    ("verified", "Read verified_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit verified. Preserve meta unchanged when present."),
    ("billable", "Read billable_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit billable. Preserve meta unchanged when present."),

    ("display_name", "Read display_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit displayName. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("city", "Read city_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit city. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("country", "Read country_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit country. Missing or None becomes the empty string. Preserve meta unchanged when present."),
    ("department", "Read department_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit department. Missing or None becomes the empty string. Preserve meta unchanged when present."),

    ("retry_after", "Read retry_after. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 0..300, and emit retryAfter. Missing, None, or blank text uses default 30. Preserve meta unchanged when present."),
    ("timeout_ms", "Read timeout_ms. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 50..10000, and emit timeoutMs. Missing, None, or blank text uses default 1000. Preserve meta unchanged when present."),
    ("batch_size", "Read batch_size. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 1..500, and emit batchSize. Missing, None, or blank text uses default 100. Preserve meta unchanged when present."),
    ("priority", "Read priority. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 0..9, and emit priority. Missing, None, or blank text uses default 5. Preserve meta unchanged when present."),
]

PUBLIC_CASES = {
    "account_id": ({"account_id": "  Acct-9 ", "meta": {"trace": 1}}, {"accountId": "acct-9", "meta": {"trace": 1}}),
    "tags": ({"tags_csv": " One, two ,,THREE "}, {"tags": ["one", "two", "three"]}),
    "amount_cents": ({"amount": "0042"}, {"amountCents": 42}),
    "enabled": ({"enabled_text": " ON "}, {"enabled": True}),
    "display_name": ({"display_name": "  Ada   Lovelace\tPhD "}, {"displayName": "Ada Lovelace PhD"}),
    "retry_after": ({"retry_after": "999"}, {"retryAfter": 300}),
}

def main() -> None:
    adapters = ROOT / "adapters"
    tests = ROOT / "tests"
    adapters.mkdir(exist_ok=True)
    tests.mkdir(exist_ok=True)
    (adapters / "__init__.py").write_text('"""Event adapter family."""\n', encoding="utf-8")

    for name, contract in SPECS:
        (adapters / f"{name}.py").write_text(
            f'"""Synthetic event adapter."""\n\nCONTRACT = {contract!r}\n\n'
            "def adapt_event(payload):\n"
            '    raise NotImplementedError("migrate this adapter according to CONTRACT")\n',
            encoding="utf-8",
        )

    public = [
        "import copy\n",
        "import importlib\n",
        "import unittest\n\n",
        "CASES = " + repr(PUBLIC_CASES) + "\n\n",
        "class PublicAdapterTests(unittest.TestCase):\n",
        "    def test_representative_contracts(self):\n",
        "        for name, (payload, expected) in CASES.items():\n",
        "            with self.subTest(adapter=name):\n",
        "                module = importlib.import_module(f'adapters.{name}')\n",
        "                original = copy.deepcopy(payload)\n",
        "                self.assertEqual(module.adapt_event(payload), expected)\n",
        "                self.assertEqual(payload, original)\n\n",
        "if __name__ == '__main__':\n",
        "    unittest.main()\n",
    ]
    (tests / "test_public.py").write_text("".join(public), encoding="utf-8")
    print(f"generated {len(SPECS)} adapter modules")

if __name__ == "__main__":
    main()
