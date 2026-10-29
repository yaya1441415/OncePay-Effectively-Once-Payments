// testing the claim: 
// never let an account go below zero, even if many 
// transfers arrive at once. it acts liek 10 users firing transfers at the sam etime 

import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { error } from 'node:console';

const REGION = process.env.AWS_REGION ?? 'ca-central-1';
const API_URL = env('API_URL');
const CLIENT_ID = env('CLIENT_ID');
const TEST_EMAIL = env('TEST_EMAIL');
const TEST_PASSWORD = env('TEST_PASSWORD');
const ACCOUNTS_TABLE = env('ACCOUNTS_TABLE');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const TRANSFERS = 10;
const AMOUNT = 3000; // 30.00
const SETTLE_TIMEOUT_MS = 60_000;

async function  main(): Promise<void> {
    const label = process.argv[2]
    if(!label) throw new Error('Usage: npx tsx scripts/race-double-spend.ts <label>')

    const token = await login()
    const prefix = subOf(token).slice(0, 8);
    const from = `acc-${prefix}-${label}-a`;
    const to = `acc-${prefix}-${label}-b`;

    const startFrom = await balanceOf(from);
    const startTo = await balanceOf(to);
    const expectedCompleted = Math.min(TRANSFERS, Math.floor(startFrom / AMOUNT));
    console.log(`Start: ${from}=${startFrom}  ${to}=${startTo}`);
    console.log(`Sending ${TRANSFERS} transfers of ${AMOUNT} at the same time...`);

    const ids = await Promise.all(
        Array.from({length: TRANSFERS}, () => createTransfer(token, from, to, AMOUNT))

    );

    //wait until every transfer has final outcome.
    const outcomes = await Promise.all(ids.map((id) => waitForSettled(token, id)))
    const completed = outcomes.filter((s) => s === 'COMPLETED').length;
    const failed = outcomes.filter((s) => s === 'FAILED').length;

    const endFrom = await balanceOf(from);
    const endTo = await balanceOf(to);
    console.log(`Outcomes: ${completed} COMPLETED, ${failed} FAILED`);
    console.log(`End:   ${from}=${endFrom}  ${to}=${endTo}`);

    const checks: Array<[string, boolean]> = [
        [`exactly ${expectedCompleted} completed`, completed === expectedCompleted],
        [`exactly ${TRANSFERS - expectedCompleted} failed`, failed === TRANSFERS - expectedCompleted],
        ['sender never negative', endFrom >= 0],
        ['sender lost exactly the completed amount', startFrom - endFrom === completed * AMOUNT],
        ['receiver gained exactly the completed amount', endTo - startTo === completed * AMOUNT],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;    
}

async function login():Promise<string> {
    const cognito = new CognitoIdentityProviderClient({region:REGION});
    const auth = await cognito.send(
        new InitiateAuthCommand({
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: CLIENT_ID,
            AuthParameters: { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD },
        })
    )
    const token = auth.AuthenticationResult?.AccessToken;
    if(!token) throw new Error('Login failed');
    return token
}

function subOf(token: string):string {
    return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub)
}

async function createTransfer(token:string, from: string, to: string, amountCents: number): Promise<string> {
    const res = await fetch(`${API_URL}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'Idempotency-Key': `race-${randomUUID()}`,
    },
        body: JSON.stringify({ fromAccountId: from, toAccountId: to, amountCents }),
    });
    if (res.status !== 202) throw new Error(`POST returned ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { transactionId: string }).transactionId;    
}

async function waitForSettled(token: string, id: string): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/transactions/${id}`, { headers: { Authorization: token } });
    if (res.ok) {
      const { status } = (await res.json()) as { status: string };
      if (status !== 'PENDING') return status;
    } else {
      console.log(`GET ${id.slice(0, 12)}... returned ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${id.slice(0, 12)}... still PENDING after ${SETTLE_TIMEOUT_MS / 1000}s`);
}

async function balanceOf(accountId:string) : Promise<number>{
    const {Item} = await ddb.send(
        new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId }, ConsistentRead: true }),
    );
    if (typeof Item?.balanceCents !== 'number') throw new Error(`${accountId} not found`)
    return Item.balanceCents;    
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
})

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}