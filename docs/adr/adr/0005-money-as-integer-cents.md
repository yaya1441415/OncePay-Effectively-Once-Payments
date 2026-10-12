# 0005: Store money as integer cents

## Status
Accepted

## Context
Floating-point numbers cannot represent many decimal amounts exactly (in JavaScript, 0.1 + 0.2 = 0.30000000000000004).
Rounding errors in a ledger break the invariant that every transaction sums to zero.

## Decision
All amounts are integers in the smallest currency unit: $12.50 is stored as 1250.
The system uses a single currency, CAD.

## Consequences
+ All arithmetic is exact
+ JavaScript numbers are exact for integers up to 2^53 - 1, far beyond any realistic amount in cents
+ Matches how payment providers such as Stripe represent amounts
- Amounts must be converted for display (1250 → "$12.50") at the edges of the system
- Supporting several currencies later would need care, since not all currencies have two decimal places
