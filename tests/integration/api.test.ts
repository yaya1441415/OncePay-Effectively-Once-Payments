import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const API = required('API_URL');
const CLIENT_ID = required('CLIENT_ID');
const EMAIL = required('TEST_EMAIL');
const PASSWORD = required('TEST_PASSWORD');


let accessToken = '';
let idToken = '';
let mine = '';
let myOther = '';
let createdId = '';


// Log in once, and work out this user's account IDs from their sub
before(async () => {
    const cognito = new CognitoIdentityProviderClient({ region: 'ca-central-1' });
    const res = await cognito.send(new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { USERNAME: EMAIL, PASSWORD },
    }));
    accessToken = res.AuthenticationResult!.AccessToken!;
    idToken = res.AuthenticationResult!.IdToken!;
    const sub: string = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;
    mine = `acc-${sub.slice(0, 8)}-checking`;
    myOther = `acc-${sub.slice(0, 8)}-savings`;
})

//auth

test('no token -> 401', async () => {
    const res = await  post({ fromAccountId: mine, toAccountId: myOther, amountCents: 100 }, { token: undefined });
    assert.equal(res.status, 401);
})

test('ID token instead of access token -> 401', async () => {
    const res = await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 100 }, { token: idToken });
    assert.equal(res.status, 401);
});

// ---------- validation at API Gateway (the Lambda never runs) ----------
test('missing Idempotency-Key header -> 400 from API Gateway', async () => {
    const res = await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 100 }, { key: null });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /Missing required request parameters/);
});

test('decimal amount -> 400 from API Gateway', async () => {
    const res = await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 1.5 });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /Invalid request body/);
});

test('unexpected field -> 400 from API Gateway', async () => {
    const res = await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 100, admin: true });
    assert.equal(res.status, 400);
});

// idempotency 
test('new transfer -> 202, then the same request -> same response, marked as replayed', async () => {
    const key = `it-${randomUUID()}`;
    const body = { fromAccountId: mine, toAccountId: myOther, amountCents: 100 };

    const first = await post(body, { key });
    assert.equal(first.status, 202);
    assert.equal(first.headers.get('idempotent-replayed'), null);

    const second = await post(body, { key });
    assert.equal(second.status, 202);
    assert.deepEqual(second.json, first.json);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');

    createdId = first.json.transactionId;
});

test('same key, different amount -> 422', async () => {
  const key = `it-${randomUUID()}`;
  await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 100 }, { key });
  const res = await post({ fromAccountId: mine, toAccountId: myOther, amountCents: 999 }, { key });
  assert.equal(res.status, 422);
});

//ownership
test("sending from someone else's account -> 403", async () => {
  const res = await post({ fromAccountId: 'acc-checking', toAccountId: mine, amountCents: 100 });
  assert.equal(res.status, 403);
});

// GET /ytansactions/{id}

test('GET own transfer -> 200, public fields only', async () => {
  const res = await get(createdId);
  assert.equal(res.status, 200);
  assert.equal(res.json.transactionId, createdId);
  assert.equal(res.json.amountCents, 100);
  for (const hidden of ['ownerId', 'payloadHash', 'idempotencyKey', 'openShard']) {
    assert.equal(hidden in res.json, false, `${hidden} must not be returned`);
  }
});

test('GET unknown id -> 404', async () => {
  assert.equal((await get('0'.repeat(64))).status, 404);
});

test('GET malformed id -> 400', async () => {
  assert.equal((await get('not-a-real-id')).status, 400);
});

//Helpers

//get name from the env variable and return an error if it doesn t exist.
function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Set the ${name} environment variable`);
    return value;
}

async function get(id: string) {
  const res = await fetch(`${API}/transactions/${id}`, { headers: { Authorization: accessToken } });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}


async function post(body: unknown, opts: { token?: string; key?: string | null } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = 'token' in opts ? opts.token : accessToken;
    if (token) headers.Authorization = token;
    if (opts.key !== null) headers['Idempotency-Key'] = opts.key ?? `it-${randomUUID()}`;
    const res = await fetch(`${API}/transactions`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => undefined) };
}