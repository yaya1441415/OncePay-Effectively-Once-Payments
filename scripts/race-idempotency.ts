import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { error } from 'node:console';

const REGION = process.env.AWS_REGION ?? 'ca-central-1';
const API_URL = env('API_URL');
const CLIENT_ID = env('CLIENT_ID');
const TEST_EMAIL = env('TEST_EMAIL');
const TEST_PASSWORD = env('TEST_PASSWORD');
const ACCOUNTS_TABLE = env('ACCOUNTS_TABLE');
const TRANSACTIONS_TABLE = env('TRANSACTIONS_TABLE');
const LEDGER_TABLE = env('LEDGER_TABLE');
const QUEUE_URL = env('QUEUE_URL');

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });

const PARALLEL = 5;
const AMOUNT = 1000; // 10.00
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

interface PostResult {
  status: number;
  transactionId?: string;
  replayed: boolean;
  attempts: number;
}


async function main(): Promise<void> {
    const label = process.argv[2];
    if(!label) throw new Error('Usage: npx tsx scripts/race-idempotency.ts <label>')
    
    const token = await login()
    const prefix = subOf(token).slice(0, 8);
    const from = `acc-${prefix}-${label}-a`;
    const to = `acc-${prefix}-${label}-b`;

    const startFrom = await balanceOf(from)
    const startTo = await balanceOf(to)
    console.log(`Start: ${from}=${startFrom}  ${to}=${startTo}`);

    // One key, five identical requests at the same moment
    const key = `idem-${randomUUID()}`; //mkes the key
    const body = JSON.stringify({ fromAccountId: from, toAccountId: to, amountCents: AMOUNT });
    const results = await Promise.all(
        Array.from({ length: PARALLEL }, () => postWithRetry(token, key, body)),
    );

    for (const [i, r] of results.entries()) {
        console.log(
            `Request ${i + 1}: ${r.status}  id=${r.transactionId?.slice(0, 12)}...  ` +
                `replayed=${r.replayed}  attempts=${r.attempts}`,
        );
    }

    const ids = new Set(results.map((r) => r.transactionId));
    const id = results[0].transactionId;
    if(!id) throw new Error('No transactionId returned');

    const status = await waitForSettled(id);
    await waitForQueueEmpty();
    const rows = await ledgerRowCount(id);
    const endFrom = await balanceOf(from);
    const endTo = await balanceOf(to);
    console.log(`Transfer ${id} → ${status}, ledger rows: ${rows}`);
    console.log(`End:   ${from}=${endFrom}  ${to}=${endTo}`);

}

async function login(): Promise<string> {
    const auth = await cognito.send(
        new InitiateAuthCommand({
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: CLIENT_ID,
            AuthParameters: { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD },
        }),
    )
    const token =  auth.AuthenticationResult?.AccessToken;
    if (!token) throw new Error('Login failed')
    return token
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

function subOf(token: string): string {
  return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
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

async function postWithRetry(token: string, key: string, body: string): Promise<PostResult> {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${API_URL}/transactions`, {
            method: 'POST',
            headers: { Authorization: token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body,
        });

        // A 5xx is safe to retry with the same key 
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
            await sleep(500 * attempt);
            continue;
        }
        const json = res.ok ? ((await res.json()) as  { transactionId: string }) : undefined;
        return {
            status: res.status,
            transactionId: json?.transactionId,
            replayed: res.headers.get('idempotent-replayed') == 'true',
            attempts: attempt
        }
    }
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


main().catch((error) => {
    console.error(error);
    process.exitCode = 1
})