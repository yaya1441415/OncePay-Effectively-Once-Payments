# 0009: No retention policies on the dev stack

## Status
Accepted

## Context
CloudFormation deletes a DynamoDB table when the stack is deleted, and when a change forces the table to be replaced (for example, changing its primary key or renaming its resource in the template).
Retention options: DeletionPolicy: Retain, UpdateReplacePolicy: Retain, and DynamoDB deletion protection.

## Decision
The dev stack uses none of these, so it can be torn down with a single `sam delete`.

## Consequences
+ Simple, complete cleanup of the dev environment
- Deleting the stack, or a change that replaces a table, deletes its data
- The 35-day backup that DynamoDB keeps for a deleted table with point-in-time recovery is encrypted with the KMS key. That key has a 7-day deletion window and no retention policy, so after `sam delete` the key is gone within 7 days and the backup can no longer be restored. Dev data is therefore treated as disposable, with no recovery.
- Point-in-time recovery on the money tables protects against bad writes while the stack exists (restore to a new table), not against stack deletion
- Rule: never rename a table's resource in the template, since that replaces the table
- A production stack would use DeletionPolicy: Retain, UpdateReplacePolicy: Retain and deletion protection on the money tables and the KMS key
