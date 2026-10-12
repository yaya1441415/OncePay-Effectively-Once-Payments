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
- Mitigation: point-in-time recovery is enabled on the money tables, and DynamoDB keeps a backup of a deleted table with point-in-time recovery for 35 days
- Rule: never rename a table's resource in the template, since that replaces the table
- A production stack would use DeletionPolicy: Retain, UpdateReplacePolicy: Retain and deletion protection on the money tables and the KMS key
