import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const REGION = process.env.AWS_REGION ?? 'ca-central-1';
const API_URL = env('API_URL');
const CLIENT_ID = env('CLIENT_ID');
const TEST_EMAIL = env('TEST_EMAIL');
const TEST_PASSWORD = env('TEST_PASSWORD');
const ACCOUNTS_TABLE = env('ACCOUNTS_TABLE');
const TRANSACTIONS_TABLE = env('TRANSACTIONS_TABLE');
const LEDGER_TABLE = env('LEDGER_TABLE');
const QUEUE_URL = env('QUEUE_URL');
const DLQ_URL = env('DLQ_URL');


const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
const sqs = new SQSClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({region: REGION});

const TOTAL = 50;
const INTERVAL_MS = 200;   // 5 per second
const AMOUNT = 100;        // 1.00
const MAX_ATTEMPTS = 3;
const SETTLE_TIMEOUT_MS = 180_000;

interface PostResult {
  status: number;
  transactionId?: string;
  attempts: number;
}



async function main(): Promise<void> {
    const label = process.argv[2];
    if (!label) throw new Error('Usage: npx tsx scripts/burst.ts <label>')

    const token = await login()
    const prefix = subOf(token).slice(0, 8)
    const from = `acc-${prefix}-${label}-a`;
    const to = `acc-${prefix}-${label}-b`;

    const startFrom = await balanceof(from)
    const startTo = await balanceof(to)
    const dlqBefore = await queueDepth(DLQ_URL);
    console.log(`Start: ${from}=${startFrom}  ${to}=${startTo}  DLQ=${dlqBefore}`);    
    
    //send at steady rate
    const t0 = Date.now();
    const posts: Promise<PostResult>[] = []
    for (let i = 0; i < TOTAL; i++){
        const key = `burst-${randomUUID()}`;
        const body = JSON.stringify({ fromAccountId: from, toAccountId: to, amountCents: AMOUNT })
        posts.push(postWithRetry(token, key, body))
        await sleep(INTERVAL_MS)
    }

    const results = await Promise.all(posts)
    const sendSeconds = (Date.now() - t0) / 1000;
    const retried = results.filter((r) => r.attempts > 1).length;
    console.log(`Sent ${TOTAL} in ${sendSeconds.toFixed(1)}s (${retried} needed a retry)`); 

    //gets the transactionID and throws away the missing 
    const ids = results.map((r) => r.transactionId).filter((id): id is string => Boolean(id))

    // until every transfer has a final status
    const statuses = await waitForAllSettled(ids)
    const settleSeconds = (Date.now() - t0) / 1000;
    console.log(
        `All settled ${settleSeconds.toFixed(1)}s after the first send ` +
        `(${(ids.length / settleSeconds).toFixed(1)} transfers/s)`,
    );    

    //Let any leftover messages finish, then measure
    await waitForQueueEmpty()
    const rows = await Promise.all(ids.map(ledgerRowCount));
    const endFrom = await balanceof(from);
    const endTo = await balanceof(to);
    const dlqAfter = await queueDepth(DLQ_URL);
    console.log(`End:   ${from}=${endFrom}  ${to}=${endTo}  DLQ=${dlqAfter}`);

    const completed = [...statuses.values()].filter((s) => s === 'COMPLETED').length;
    const total = TOTAL * AMOUNT;
    const checks: Array<[string, boolean]> = [
        [`all ${TOTAL} requests returned 202`, results.every((r) => r.status === 202)],
        [`all ${TOTAL} transfers COMPLETED`, completed === TOTAL],
        ['exactly 2 ledger rows per transfer', rows.every((n) => n === 2)],
        [`sender lost exactly ${total}`, startFrom - endFrom === total],
        [`receiver gained exactly ${total}`, endTo - startTo === total],
        ['nothing new in the DLQ', dlqAfter === dlqBefore],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}



// Helpers:
//checks ll transfers until everyone is finished, give up after 3 min
async function waitForAllSettled(ids: string[]): Promise<Map<string, string>> {
    const settled = new Map<string, string>();
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (settled.size < ids.length && Date.now() < deadline) {
        const pending = ids.filter((id) => !settled.has(id));
        await Promise.all(
            pending.map(async (id) => {
                const { Item } = await ddb.send(
                    new GetCommand({ TableName: TRANSACTIONS_TABLE, Key: { transactionId: id }, ConsistentRead: true }),
                );
                if (Item && Item.status !== 'PENDING') settled.set(id, String(Item.status));
            }),
        );
        if(settled.size < ids.length) await sleep(1000);
    }
    if (settled.size < ids.length) {
        throw new Error(`${ids.length - settled.size} transfers still PENDING after ${SETTLE_TIMEOUT_MS / 1000}s`);
    }
    return settled;

}

async function login(): Promise<string> {
    const auth = await cognito.send(
        new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD },
        }),
    );

    const token = auth.AuthenticationResult?.AccessToken;
    if(!token) throw new Error('Login failed');
    return token;
}

function subOf(token: string): string {
    return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function balanceof(accountId: string): Promise<number> {
    const { Item } = await ddb.send(
        new GetCommand({TableName: ACCOUNTS_TABLE, Key: {accountId}, ConsistentRead: true}),
    )
    if (typeof Item?.balanceCents !== 'number') throw new Error(`${accountId} not found`)
    return Item.balanceCents;
}

//sends one reqiuest if server has temporary problem
//it tries again.
async function postWithRetry(token: string, key: string, body: string): Promise<PostResult> {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${API_URL}/transactions`, {
            method: 'POST',
            headers: { Authorization: token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body,
        });
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
            await sleep(500 * attempt);
            continue;
        }
        const json = res.ok ? ((await res.json()) as { transactionId: string }) : undefined;
        return { status: res.status, transactionId: json?.transactionId, attempts: attempt };
    }
}

//How many messages are still in the queue?
async function queueDepth(url: string): Promise<number> {
    const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
    );
    return (
        Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
}

async function waitForQueueEmpty(): Promise<void> {
    await sleep(3000);
    const deadline = Date.now() + 60_000;
    let emptyInARow = 0;
    while (Date.now() < deadline) {
        emptyInARow = (await queueDepth(QUEUE_URL)) === 0 ? emptyInARow + 1 : 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});