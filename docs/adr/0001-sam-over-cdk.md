# 0001: Use AWS SAM as the infrastructure-as-code tool

## Status
Accepted

## Context
The system is serverless-only: Lambda, API Gateway, DynamoDB, SQS, Step Functions and EventBridge.
.

Options considered: AWS CDK (TypeScript code) or AWS SAM (YAML template + TypeScript Lambdas).


## Decision
Use AWS SAM, with TypeScript Lambdas bundled by esbuild.

## Consequences
+ Event sources (SQS, DynamoDB Streams, EventBridge, schedules) are wired in a few lines
+ Built-in support for Lambda versions, aliases and CodeDeploy canary deployments
+ `sam validate --lint`, `sam build` and `sam deploy` cover the whole workflow
- Less type safety than CDK: template mistakes are caught by the linter or at deploy time, not by a compiler
- Large templates are harder to refactor than CDK code
