# 0006: Use one table per kind of data

## Status
Accepted

## Context
DynamoDB designs often use single-table design: every kind of item in one table, with generic keys (PK, SK).
This project stores four kinds of data with different needs:
- Transactions: transfer requests and their status
- Accounts: owners and balances
- Ledger: immutable debit and credit entries
- ProcessedEvents: temporary deduplication records

## Decision
Use four separate tables.

## Consequences
+ Each table is easy to read and reason about, which matters for a project that must be explained in interviews
+ IAM permissions can be granted per table (for example, a function that can read Accounts but never write the Ledger)
+ Settings differ per table: only ProcessedEvents has TTL; only the money tables (Transactions, Accounts, Ledger) use point-in-time recovery, since ProcessedEvents is disposable dedup data that expires on its own
- Related items of different types cannot be fetched in a single query
- The transfer touches two tables (Accounts and Ledger), so it uses a DynamoDB transaction across tables
- More indexes overall than a carefully designed single table
