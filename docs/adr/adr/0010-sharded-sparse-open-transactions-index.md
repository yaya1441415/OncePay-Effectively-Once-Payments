# 0010: Write-sharded, sparse index for open transactions

## Status
Accepted

## Context
The reconciliation job must find transactions that are still open (PENDING or PROCESSING), to detect any that are stuck.
The first design keyed an index by status. Every new transaction would then write to the index under the same one or two key values.
DynamoDB spreads load by partition key value, and a single key value supports roughly 1,000 writes per second. If a global secondary index cannot keep up, DynamoDB also throttles writes to the base table, so one index could slow the whole API.

## Decision
- The index key is openShard, with values OPEN#0 to OPEN#9, derived from the transactionId (the same transaction always gets the same shard).
- The sort key is createdAt, so each shard lists the oldest open transactions first.
- The index is sparse: openShard is removed when a transaction completes, so only open transactions appear in it.

## Consequences
+ Index writes spread over 10 key values instead of 1 or 2
+ The index stays small however many transactions have ever been processed
- The reconciliation job runs 10 small queries (one per shard) instead of 1
- Index reads are eventually consistent, which is acceptable for detecting stuck transactions
- The code must remember to remove openShard on completion; a bug there would leave completed transactions in the index (also detectable by reconciliation)
