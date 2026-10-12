# 0007: One idempotency mechanism for the API: deterministic ID + conditional write

## Status
Accepted

## Context
Clients and SDKs retry requests on timeouts and errors, so the API must never create the same transfer twice.
A first design combined two mechanisms: the Powertools Idempotency utility (its own table) and a conditional write on the Transactions table. A design review asked which one was the source of truth, since the two could disagree.
With a random transactionId, a Lambda that saves the transaction and is then killed before Powertools records completion would, on retry, create a second transaction with a new ID.

## Decision
- transactionId = SHA-256 of (userId + separator + Idempotency-Key). The separator prevents different user/key pairs from producing the same text.
- The API's only side effect is one conditional write: create the transaction only if that ID does not exist.
- A hash of the request body is stored on the transaction.
- The Transactions table is the single source of truth. The Powertools Idempotency utility is not used for the API.

Behaviour:
- Duplicate request, same body: the conditional write fails, the existing transaction is read, and the same 202 response is returned. This includes duplicates arriving at the same moment.
- Same key, different body: 422.

## Consequences
+ The key and its effect are committed in the same atomic write, so nothing can be half-done
+ Keys are scoped per user: two users sending the same key get different transactions
+ No 409 "in progress" state is needed, because there is no in-progress state
- Keys never expire: a client reusing a key months later receives the old transaction (documented behaviour)
- Response replay and payload checks are written by hand instead of coming from a library
- Events (EventBridge, Stripe webhooks) still need deduplication by event ID, handled by the ProcessedEvents table with a 24-hour TTL
