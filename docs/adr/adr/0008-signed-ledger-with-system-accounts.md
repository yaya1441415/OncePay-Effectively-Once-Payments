# 0008: Signed double-entry ledger with system accounts

## Status
Accepted

## Context
The ledger records every movement of money and must make correctness checkable.
Entries can be unsigned (direction stored separately) or signed (+ for credit, - for debit).
Money entering the system (opening balances, Stripe deposits) has no counterpart inside it, which would break a "sums to zero" rule.

## Decision
- Ledger entries are signed: positive for credits, negative for debits. Entries are never edited or deleted; refunds write reversing entries.
- Every transaction's entries sum to zero.
- System accounts hold the other side of money entering the system: sys-opening-balances for seeded balances and sys-stripe-clearing for deposits. Only system accounts may go negative.
- System accounts have no ownerId, so they are excluded from the ByOwner index.

## Consequences
+ Invariants become simple sums: per transaction, per account (balance = sum of its entries), and for the whole ledger (always 0)
+ The ledger is a complete, append-only history that can explain any balance
- DynamoDB has no SUM query: sums are computed in code, using a Query per transaction or account, or a Scan for whole-ledger checks
- Known limitation: sys-stripe-clearing is a single item updated by every deposit. At high volume this becomes a hot item and a source of transaction conflicts. Fix if needed: shard it into sys-stripe-clearing#0 to #9, whose balances sum to the clearing balance.
