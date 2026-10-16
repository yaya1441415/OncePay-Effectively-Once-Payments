# 0012: Insufficient funds is decided atomically in the ledger step, not at the API

## Status
Accepted

## Context
The API could check the sender's balance before accepting a transfer and answer 422 right away.
That balance is read without any lock. Two requests can both read 100.00 and both be accepted for 80.00, so the API check can never be the real guard. A check that is sometimes wrong and sometimes right is also hard to explain.

## Decision
- The API checks only things that cannot change: valid body, sender owned by the caller, destination exists and is a customer account.
- The balance is enforced in one place: the transfer's TransactWriteItems debits the sender with the condition balanceCents >= amount.
- If that condition fails, the cancellation reason is permanent: the workflow catches it and sets the transaction to REJECTED. No ledger entries are written and no balance changes.
- The client learns the outcome from the transaction status (GET /transactions/{id}), not from the POST response.

## Consequences
+ One enforcement point; no race between check and debit
+ Invariant 3 (no customer balance below zero) is guaranteed by the condition, whatever the API did
+ The API stays a single conditional write
- A client sending an obviously impossible transfer gets 202 first and REJECTED later, instead of an immediate error
- The workflow must tell cancellation reasons apart: insufficient funds (permanent, REJECTED), ledger entry already exists (a retry after success, treated as success) and transaction conflict (temporary, retried)
