# Migrate the event adapter family

The `adapters/` package contains **24 independent adapters**. Every module exposes a
natural-language `CONTRACT` and a broken `adapt_event(payload)` stub.

Implement all adapters so each one follows its own contract exactly.

## Requirements

- Treat each module's `CONTRACT` as the source of truth.
- `adapt_event(payload)` must return a fresh dictionary and must not mutate its input.
- Preserve `payload["meta"]` unchanged when it is present, as stated by every contract.
- You may add shared helpers when several adapters have the same transformation shape.
- Use only the Python standard library.
- Do not modify the contract strings, `scripts/setup.py`, or `tests/test_public.py`.
- Run `python3 -m unittest discover -s tests`.
- Record the approach, grouping/reuse decisions, and verification evidence in
  `work/report.md`.

The public tests are examples, not complete coverage. Finish the whole adapter family,
not only the examples that are visible in the public suite.
