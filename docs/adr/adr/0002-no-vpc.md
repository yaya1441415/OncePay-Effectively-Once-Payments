# 0002: Run the Lambdas outside a VPC

## Status
Accepted

## Context
Placing Lambdas in an isolated subnet with no internet route blocks data exfiltration, but every AWS service must then be reached through VPC endpoints.
Every service this project uses (DynamoDB, SQS, Step Functions, EventBridge, KMS, Secrets Manager) is reached through IAM-authenticated AWS APIs.
Interface endpoints cost about $0.01 per hour each, per Availability Zone, even when idle.

## Decision
Run all Lambdas outside a VPC. Access is controlled with one least-privilege IAM role per function.

## Consequences
+ No hourly endpoint costs, which keeps the project close to free when idle
+ Simpler deployments and faster iteration
+ IAM still limits exactly which tables, queues and keys each function can use
- A compromised dependency could send data to the internet; network isolation would block that
- Mitigated by dependency scanning in CI (npm audit, Dependabot) and by logging IDs only, never personal data
- A production deployment holding real customer data should revisit this: isolated subnets, gateway endpoints for DynamoDB and S3, interface endpoints for the other services
