# 0004: Put an SQS queue in front of Step Functions

## Status
Accepted

## Context
New transactions must start a Step Functions workflow.
EventBridge Pipes can start a workflow directly, without a queue. Alternatively, the Pipe can send to SQS, and a processor Lambda starts the workflow.

## Decision
Pipe → SQS → processor Lambda → Step Functions.

## Consequences
+ The queue buffers bursts, so traffic spikes don't overwhelm the workflow
+ A dead-letter queue and SQS redrive give a clear, tested way to handle and replay failures
+ Batch size, visibility timeout and partial batch responses give fine control over retries
+ Covers SQS event source mappings, which the DVA-C02 exam tests heavily
- One extra hop and one extra Lambda, adding a little latency and cost
- The processor must start workflows idempotently: the execution name is the transactionId, and ExecutionAlreadyExists is treated as success
