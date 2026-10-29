import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const REGION = process.env.AWS_REGION ?? 'ca-central-1';
const API_URL = env('API_URL');
const CLIENT_ID = env('CLIENT_ID');
const TEST_EMAIL = env('TEST_EMAIL');
const TEST_PASSWORD = env('TEST_PASSWORD');
const ACCOUNTS_TABLE = env('ACCOUNTS_TABLE');
const TRANSACTIONS_TABLE = env('TRANSACTIONS_TABLE');
const LEDGER_TABLE = env('LEDGER_TABLE');
const QUEUE_URL = env('QUEUE_URL');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });

const ROUNDS = 5;     // transfers
const COPIES = 5;     // extra deliveries per transfer (plus the Pipe's own)
const AMOUNT = 1000;  // 10.00
const TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const label = process.argv[2];
  if (!label) throw new Error('Usage: npx tsx scripts/race-duplicate-delivery.ts <label>');

  const token = await login();
  const prefix = subOf(token).slice(0, 8);
  const from = `acc-${prefix}-${label}-a`;
  const to = `acc-${prefix}-${label}-b`;

  const startFrom = await balanceOf(from);
  const startTo = await balanceOf(to);
  console.log(`Start: ${from}=${startFrom}  ${to}=${startTo}`);

  const ids: string[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const id = await createTransfer(token, from, to, AMOUNT);
    ids.push(id);
    // Fire the duplicates at the same moment, racing the Pipe's own message
    await Promise.all(
      Array.from({ length: COPIES }, () =>
        sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify({ transactionId: id }) })),
      ),
    );
    console.log(`Round ${round}: ${id.slice(0, 12)}... + ${COPIES} duplicate messages`);
  }

  const statuses = await Promise.all(ids.map(waitForSettled));
  await waitForQueueEmpty(); // every duplicate has been handled too

  const rows = await Promise.all(ids.map(ledgerRowCount));
  const endFrom = await balanceOf(from);
  const endTo = await balanceOf(to);
  console.log(`End:   ${from}=${endFrom}  ${to}=${endTo}`);
  console.log(`Statuses: ${statuses.join(', ')}`);
  console.log(`Ledger rows per transfer: ${rows.join(', ')}`);

  const total = ROUNDS * AMOUNT;
  const checks: Array<[string, boolean]> = [
    ['every transfer COMPLETED', statuses.every((s) => s === 'COMPLETED')],
    ['exactly 2 ledger rows per transfer', rows.every((n) => n === 2)],
    [`sender lost exactly ${total}`, startFrom - endFrom === total],
    [`receiver gained exactly ${total}`, endTo - startTo === total],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}

async function login(): Promise<string> {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const auth = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD },
    }),
  );
  const token = auth.AuthenticationResult?.AccessToken;
  if (!token) throw new Error('Login failed');
  return token;
}

function subOf(token: string): string {
  return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
}

async function createTransfer(token: string, from: string, to: string, amountCents: number): Promise<string> {
  const res = await fetch(`${API_URL}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'Idempotency-Key': `dup-${randomUUID()}`,
    },
    body: JSON.stringify({ fromAccountId: from, toAccountId: to, amountCents }),
  });
  if (res.status !== 202) throw new Error(`POST returned ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { transactionId: string }).transactionId;
}

async function waitForSettled(id: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: TRANSACTIONS_TABLE, Key: { transactionId: id }, ConsistentRead: true }),
    );
    if (Item && Item.status !== 'PENDING') return String(Item.status);
    await sleep(1000);
  }
  throw new Error(`${id.slice(0, 12)}... still PENDING after ${TIMEOUT_MS / 1000}s`);
}

async function waitForQueueEmpty(): Promise<void> {
  await sleep(3000);
  const deadline = Date.now() + TIMEOUT_MS;
  let emptyInARow = 0;
  while (Date.now() < deadline) {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: QUEUE_URL,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const total =
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    emptyInARow = total === 0 ? emptyInARow + 1 : 0;
    if (emptyInARow >= 2) return;
    await sleep(1000);
  }
  throw new Error('Queue did not drain in time');
}

async function ledgerRowCount(transactionId: string): Promise<number> {
  const { Count } = await ddb.send(
    new QueryCommand({
      TableName: LEDGER_TABLE,
      KeyConditionExpression: 'transactionId = :t',
      ExpressionAttributeValues: { ':t': transactionId },
      ConsistentRead: true,
      Select: 'COUNT',
    }),
  );
  return Count ?? 0;
}

async function balanceOf(accountId: string): Promise<number> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId }, ConsistentRead: true }),
  );
  if (typeof Item?.balanceCents !== 'number') throw new Error(`${accountId} not found`);
  return Item.balanceCents;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});