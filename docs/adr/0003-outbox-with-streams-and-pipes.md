# 0003: Use an outbox (DynamoDB Streams + EventBridge Pipes) instead of sending to SQS from the API

## Status
Accepted

## Context
When a transfer is created, two things must happen: the transaction is saved, and a message is queued for processing.
If the API Lambda does both (write to DynamoDB, then send to SQS), a crash between the two leaves a saved transaction that is never processed. This is the dual-write problem. Retrying the request does not help if the client never retries.

## Decision
The API Lambda only writes the transaction to DynamoDB.
A DynamoDB Stream captures the new item, and an EventBridge Pipe forwards new PENDING transactions to the SQS queue.

## Consequences
+ One atomic write: a saved transaction is always eventually queued
+ No queue-sending code or SQS permissions in the API Lambda
+ The Pipe filters events, so only new PENDING transactions are forwarded
- Two more services to understand and monitor (the stream and the Pipe)
- Stream records can be delivered more than once, so every later hop must be idempotent (it already is by design)
- Stream records are kept for 24 hours; a Pipe stopped for longer than that would miss transactions (the stuck-transaction sweeper finds transactions still PENDING in the OpenTransactions index and re-queues them; it is a core component, not a stretch one, because invariant 4 depends on it)
