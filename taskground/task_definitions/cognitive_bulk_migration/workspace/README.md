# Event adapter migration fixture

This repository is a synthetic family of small event adapters. Setup creates:

```text
adapters/             24 modules with CONTRACT + broken adapt_event stub
tests/test_public.py  representative public behavior checks
scripts/setup.py      deterministic fixture generator
work/                 your retained report/evidence
```

Each contract fully specifies one local transformation. Several modules share the same
transformation family with different source/target fields or parameters. You may
factor shared code when useful, but each module must continue to expose its own
`adapt_event(payload)` function and unchanged `CONTRACT`.

The held-out verifier checks every adapter with unseen inputs, input immutability,
metadata preservation, error behavior where documented, and the public test suite.
