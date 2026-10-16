# 0011: KMS key policy: IAM delegation now, tighter policy before CI/CD

## Status
Proposed (to be applied before Milestone 10)

## Context
All tables are encrypted with a customer-managed KMS key.
The current key policy is AWS's default: it delegates to IAM (principal: the account root, kms:*). No identity can use the key unless its IAM policy also allows it, so least privilege is enforced in each Lambda's IAM policy.
However, any identity with broad IAM permissions (an administrator) could call KMS directly and decrypt data outside DynamoDB.

## Decision
Keep the default policy while building, since each new service would otherwise risk AccessDenied errors that are hard to tell apart from code bugs.
Before Milestone 10, replace it with a policy that:
- allows administration (rotate, disable, change policy, schedule deletion) but not encryption or decryption
- allows encryption and decryption only through DynamoDB, SQS and Secrets Manager, using the kms:ViaService condition
- lets the DynamoDB service describe the key

## Consequences
+ Separation of duties: managing the key is separate from using it
+ Nobody, including administrators, can decrypt data by calling KMS directly
+ The key policy can be changed in place, so deferring it costs nothing
- Every new service that needs the key must be added to the kms:ViaService list
- Verified by test: after the change, the full system still works, and a direct `aws kms decrypt` is denied
