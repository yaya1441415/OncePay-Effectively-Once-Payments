import type { SQSEvent, SQSRecord, SQSBatchResponse } from 'aws-lambda';
import {
  DynamoDBClient,
  TransactionCanceledException,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TRANSACTIONS_TABLE = requireEnv('TRANSACTIONS_TABLE');
const ACCOUNTS_TABLE = requireEnv('ACCOUNTS_TABLE');
const LEDGER_TABLE = requireEnv('LEDGER_TABLE');

const ID_PATTERN = /^[0-9a-f]{64}$/;

const DEBIT_ACCOUNT = 0;
const MARK_COMPLETED = 4;

type Outcome = 'COMPLETED' | 'FAILED_INSUFFICIENT_FUNDS' | 'ALREADY_PROCESSED';


interface Transfer {
  transactionId: string;
  status: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures:SQSBatchResponse['batchItemFailures'] = []
    for (const record of event.Records){
        try {
            await ProcessRecord(record)
            
            
        } catch (error) {
            console.log(JSON.stringify({
                level: 'error',
                messageId: record.messageId,
                error: error instanceof Error ? error.name : 'Unknown',
            }));
            batchItemFailures.push({ itemIdentifier: record.messageId });
            
        }
    }
    return { batchItemFailures };
}


async function ProcessRecord(record: SQSRecord): Promise<void> {
    const transactionId = parseTransactionId(record.body);
    const outcome = await settle(transactionId);

    log('info', {
        messageId: record.messageId,
        transactionId,
        outcome,
        receiveCount: record.attributes.ApproximateReceiveCount
    });
}

function parseTransactionId(raw: string): string {
    const body: unknown = JSON.parse(raw)

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw namedError('InvalidMessageBody');
    }

    const transactionId = (body as { transactionId?: unknown }).transactionId;
    if (typeof transactionId !== 'string' || !ID_PATTERN.test(transactionId)) {
        throw namedError('InvalidMessageBody');
    }

    return transactionId
}

// Move the money exactly once
async function settle(transactionId:string): Promise<Outcome>{
    const { Item } = await ddb.send(
        new GetCommand({
            TableName: TRANSACTIONS_TABLE,
            Key: { transactionId },
            ConsistentRead: true,
        }),
    );

    if(!Item) throw namedError('TransactionNotFound');
    if(Item.status !== 'PENDING') return 'ALREADY_PROCESSED';

    const tx = toTransfer(Item);
    const now = new Date().toISOString();

    try{
        await ddb.send(
            new TransactWriteCommand({
                TransactItems: [
                    //0- take money from sender, only if they have enough
                    {
                        Update: {
                            TableName: ACCOUNTS_TABLE,
                            Key: { accountId: tx.fromAccountId },
                            UpdateExpression: 'SET balanceCents  = balanceCents  - :amt',
                            ConditionExpression: 'balanceCents  >= :amt',
                            ExpressionAttributeValues: { ':amt': tx.amountCents },
                        },
                    },
                    // 1: give it to teh receiver, only if teh account exists 
                    {
                        Update: {
                            TableName: ACCOUNTS_TABLE,
                            Key: {accountId: tx.toAccountId},
                            UpdateExpression: 'SET balanceCents  = balanceCents  + :amt',
                            ConditionExpression: 'attribute_exists(accountId)',
                            ExpressionAttributeValues: {':amt': tx.amountCents},
                        },
                    },
                    // 2: ledger debit (negative)
                    {
                        Put: {
                            TableName: LEDGER_TABLE,
                            Item: {
                                transactionId,
                                entryId: `DEBIT#${tx.fromAccountId}`,
                                accountId: tx.fromAccountId,
                                amountCents: -tx.amountCents,
                                postedAt: now,
                            },
                            ConditionExpression: 'attribute_not_exists(transactionId)',
                        },
                    },
                    // 3: ledger credit (positive)
                    {
                        Put: {
                            TableName: LEDGER_TABLE,
                            Item: {
                                transactionId,
                                entryId: `CREDIT#${tx.toAccountId}`,
                                accountId: tx.toAccountId,
                                amountCents: tx.amountCents,
                                postedAt: now,
                            },
                            ConditionExpression: 'attribute_not_exists(transactionId)',
                        },
                    },
                                        // 4: mark completed, only if still PENDING (the exactly-once guard)
                    {
                        Update: {
                            TableName: TRANSACTIONS_TABLE,
                            Key: { transactionId },
                            UpdateExpression: 'SET #s = :completed, settledAt = :now REMOVE openShard',
                            ConditionExpression: '#s = :pending',
                            ExpressionAttributeNames: { '#s': 'status' },
                            ExpressionAttributeValues: {
                                ':completed': 'COMPLETED',
                                ':pending': 'PENDING',
                                ':now': now,
                            },
                        },
                    },
                ],
            }),
        );
        return 'COMPLETED';
    } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        const codes = (error.CancellationReasons ?? []).map((r) => r.Code);

        // Check "already done" first: if it completed, the sender's balance
        // is lower now, so the funds check may also fail.
        if (codes[MARK_COMPLETED] === 'ConditionalCheckFailed') return 'ALREADY_PROCESSED';
        if (codes[DEBIT_ACCOUNT] === 'ConditionalCheckFailed') return markFailed(transactionId, now);

        log('error', {transactionId, cancellationReasons: codes})
        throw error
    }


    
}

async function markFailed(transactionId: string, now: string): Promise<Outcome> {
    try {
        await ddb.send(
        new UpdateCommand({
            TableName: TRANSACTIONS_TABLE,
            Key: { transactionId },
            UpdateExpression: 'SET #s = :failed, failureReason = :reason, settledAt = :now REMOVE openShard',
            ConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
            ':failed': 'FAILED',
            ':reason': 'INSUFFICIENT_FUNDS',
            ':pending': 'PENDING',
            ':now': now,
            },
        }),
        );
        return 'FAILED_INSUFFICIENT_FUNDS';
    } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return 'ALREADY_PROCESSED';
        throw error;
    }
}



// Helpers
function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function log(level: 'info' | 'error', fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, ...fields }));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function toTransfer(item: Record<string, unknown>): Transfer {
  const { transactionId, status, fromAccountId, toAccountId, amountCents } = item;
  if (
    typeof transactionId !== 'string' ||
    typeof status !== 'string' ||
    typeof fromAccountId !== 'string' ||
    typeof toAccountId !== 'string' ||
    typeof amountCents !== 'number' ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    throw namedError('InvalidTransactionItem');
  }
  return { transactionId, status, fromAccountId, toAccountId, amountCents };
}


