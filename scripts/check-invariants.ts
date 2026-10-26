import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, paginateScan, paginateQuery } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }),
);

const ACCOUNTS_TABLE = requireEnv('ACCOUNTS_TABLE');
const LEDGER_TABLE = requireEnv('LEDGER_TABLE');
const TRANSACTIONS_TABLE = requireEnv('TRANSACTIONS_TABLE');

const SHARDS = 10;
const STUCK_AFTER_MS = 5 * 60 * 1000;

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const [accounts, ledger, stuck] = await Promise.all([
    scanAll(ACCOUNTS_TABLE),
    scanAll(LEDGER_TABLE),
    stuckPending(),
  ]);

  // Group ledger rows by account and by transaction
  const byAccount = new Map<string, number>();
  const byTransaction = new Map<string, number>();
  for (const row of ledger) {
    const amount = cents(row.amountCents, 'ledger.amountCents');
    const accountId = String(row.accountId);
    const transactionId = String(row.transactionId);
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + amount);
    byTransaction.set(transactionId, (byTransaction.get(transactionId) ?? 0) + amount);
  }

  const ledgerSum = sum(ledger.map((r) => cents(r.amountCents, 'ledger.amountCents')));
  const balanceSum = sum(accounts.map((a) => cents(a.balanceCents, 'account.balanceCents')));

  const negativeCustomers = accounts
    .filter((a) => a.accountType === 'customer' && cents(a.balanceCents, 'balanceCents') < 0)
    .map((a) => String(a.accountId));

  const unreconciled = accounts
    .filter((a) => cents(a.balanceCents, 'balanceCents') !== (byAccount.get(String(a.accountId)) ?? 0))
    .map((a) => String(a.accountId));

  const oneSided = [...byTransaction.entries()]
    .filter(([, total]) => total !== 0)
    .map(([id]) => id);

  const checks: Array<[string, boolean, string]> = [
    ['1. Ledger sums to 0', ledgerSum === 0, `sum = ${ledgerSum}`],
    ['2. Balances sum to 0', balanceSum === 0, `sum = ${balanceSum}`],
    ['3. No negative customer balance', negativeCustomers.length === 0, list(negativeCustomers)],
    ['4. Nothing PENDING > 5 min', stuck.length === 0, list(stuck)],
    ['5. Each balance = its ledger', unreconciled.length === 0, list(unreconciled)],
    ['6. Each transaction sums to 0', oneSided.length === 0, list(oneSided)],
  ];

  console.log(`Accounts: ${accounts.length}   Ledger rows: ${ledger.length}\n`);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? '\nAll invariants hold.' : `\n${failed} invariant(s) FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function scanAll(table: string): Promise<Row[]> {
  const items: Row[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: table, ConsistentRead: true })) {
    items.push(...(page.Items ?? []));
  }
  return items;
}

async function stuckPending(): Promise<string[]> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const ids: string[] = [];
  for (let shard = 0; shard < SHARDS; shard++) {
    const pages = paginateQuery(
      { client: ddb },
      {
        TableName: TRANSACTIONS_TABLE,
        IndexName: 'OpenTransactions',
        KeyConditionExpression: 'openShard = :s AND createdAt < :cutoff',
        ExpressionAttributeValues: { ':s': `OPEN#${shard}`, ':cutoff': cutoff },
        ProjectionExpression: 'transactionId',
      },
    );
    for await (const page of pages) {
      for (const item of page.Items ?? []) ids.push(String(item.transactionId));
    }
  }
  return ids;
}

function cents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} is not an integer: ${JSON.stringify(value)}`);
  }
  return value;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function list(ids: string[]): string {
  if (ids.length === 0) return 'none';
  const shown = ids.slice(0, 5).map((id) => (id.length > 20 ? `${id.slice(0, 12)}...` : id));
  return `${ids.length}: ${shown.join(', ')}${ids.length > 5 ? ', ...' : ''}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});