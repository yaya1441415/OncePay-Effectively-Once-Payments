import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { transactionIdFor, openShardFor, payloadHashFor } from '../shared/ids';

//POST /transactions ("send money")


const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));//connection with dynamoDB
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const MAX_AMOUNT_CENTS = 1_000_000;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;


//describe what a valid body looks like:
interface TransferRequest {
    fromAccountId: string;
    toAccountId: string;
    amountCents: number;
}



//entry point 
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        return await createTransaction(event)
    }catch (error) {
        console.error(JSON.stringify({ level: 'ERROR', msg: 'unhandled', error: String(error) }));
        return {
            'statusCode': 500, 
            headers: { 'Content-Type': 'application/json' }, // optional 
            body: JSON.stringify({ message: 'Internal error' }), 
        }
    }
}

async function createTransaction(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = event.requestContext.authorizer?.claims?.sub; // who is calling ?
    if (typeof userId!=='string' || !userId) return reply(401, { message: 'Unauthorized' });
    
    const tokenUse = event.requestContext.authorizer?.claims?.token_use;
    if(tokenUse !== 'access') return reply(401, {message: 'Unauthorized'})

    const key = header(event, 'idempotency-key'); //reads the idempotency header
    if (!key || !KEY_PATTERN.test(key)) { //isn t text or empty
        return reply(400, {message: 'Idempotency-Key header must be 8-128 letters, digits, - or _' })
    }

    const req = parseBody(event.body);
    if (!req) {
        return reply(400, { message: 'Body must be {fromAccountId, toAccountId, amountCents}, with amountCents a whole number from 1 to 1000000' });
    }

    //reads both the accounts from dynamodb at the same time
    const [from, to] = await Promise.all([getAccount(req.fromAccountId), getAccount(req.toAccountId)]);
    if(!from || from.ownerId !== userId || from.accountType !== 'customer') {
        return reply(403, { message: 'You can only send from your own accounts' });
    }

    if (!to || to.accountType !== 'customer') {
        return reply(422, { message: 'Destination account not found' });
    }


    const transactionId = transactionIdFor(userId, key);
    const payloadHash = payloadHashFor(req.fromAccountId, req.toAccountId, req.amountCents);
    const item = {
        transactionId,
        ownerId: userId,
        idempotencyKey: key,
        payloadHash,
        fromAccountId: req.fromAccountId,
        toAccountId: req.toAccountId,
        amountCents: req.amountCents,
        currency: 'CAD',
        status: 'PENDING',
        openShard: openShardFor(transactionId),
        createdAt: new Date().toISOString(),
    }
    try {
        //write item to this table only if no item with this transaction ID exist
        await ddb.send(new PutCommand({
            TableName: TRANSACTIONS_TABLE,
            Item: item,
            ConditionExpression: 'attribute_not_exists(transactionId)',
        }));
        log('transaction_created', transactionId)
        return reply(202, toResponse(item))
    }catch(error) {
        if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    }

    const existing = (await ddb.send(new GetCommand({
        TableName: TRANSACTIONS_TABLE,
        Key: { transactionId },
        ConsistentRead: true, //always the latest data
    }))).Item;

    if(!existing) throw new Error('Conditional write failed but the transaction was not found') 
    
    if(existing.payloadHash !== payloadHash) {
        log('idempotency_key_reused', transactionId);
        return reply(422, { message: 'This Idempotency-Key was already used with a different request' });
    }
    log('duplicate_suppressed', transactionId);
    return reply(202, toResponse(existing), { 'Idempotent-Replayed': 'true' });
}


// ---------- helpers ----------


async function getAccount(accountId: string) {
    const res = await ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId } }));
    return res.Item;
}

// HTTP header names are case-insensitive
function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const found = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === name);
  return found?.[1] ?? undefined;
}

function reply(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function log(msg: string, transactionId: string) {
  console.log(JSON.stringify({ level: 'INFO', msg, transactionId }));
}


function toResponse(item: Record<string, unknown>) {
  return { transactionId: item.transactionId, status: item.status, createdAt: item.createdAt };
}

function parseBody(body: string | null): TransferRequest | undefined {
  let data: unknown;
  try { data = JSON.parse(body ?? ''); } catch { return undefined; }
  if (typeof data !== 'object' || data === null) return undefined
  const r = data as Partial<TransferRequest>;
  const validId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64;
  if (!validId(r.fromAccountId) || !validId(r.toAccountId)) return undefined;
  if (r.fromAccountId === r.toAccountId) return undefined;
  if (!Number.isInteger(r.amountCents) || r.amountCents! < 1 || r.amountCents! > MAX_AMOUNT_CENTS) return undefined;
  return r as TransferRequest;
}