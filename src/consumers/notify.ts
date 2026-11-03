import type { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const PROCESSED_EVENTS_TABLE = requireEnv('PROCESSED_EVENTS_TABLE');

const CONSUMER = 'notify';
const STALE_CLAIM_MS = 60_000;                 // Lambda timeout is 10 s, so an older claim is a crashed attempt
const RECORD_TTL_SECONDS = 2 * 24 * 60 * 60;   // outlives every retry window
const EVENT_ID_PATTERN = /^[0-9a-f]{64}#(COMPLETED|FAILED)$/;

interface TransferSettled {
  eventId: string;
  transactionId: string;
  status: string;
  ownerId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: string;
  currency: string;
  settledAt: string;
}

export const handler = async (
  event: EventBridgeEvent<'TransferSettled', TransferSettled>,
): Promise<void> => {
  const detail = event.detail;
  if (!EVENT_ID_PATTERN.test(detail.eventId)) throw namedError('InvalidEvent');

  // One record per consumer per event, so consumers never block each other
  const recordId = `${CONSUMER}#${detail.eventId}`;

  // 1. Claim
  if (!(await claim(recordId))) {
    const existing = await getRecord(recordId);
    if (existing?.state === 'DONE') {
      log('info', { eventId: detail.eventId, outcome: 'ALREADY_NOTIFIED' });
      return;
    }
    // Another delivery is working on it right now: fail, so it's retried later
    throw namedError('NotificationInProgress');
  }

  // 2. Send
  sendNotification(detail);

  // 3. Mark done
  await markDone(recordId);
  log('info', { eventId: detail.eventId, outcome: 'NOTIFIED' });
};

async function claim(recordId: string): Promise<boolean> {
  const now = Date.now();
  try {
    await ddb.send(
      new PutCommand({
        TableName: PROCESSED_EVENTS_TABLE,
        Item: {
          eventId: recordId,
          state: 'IN_PROGRESS',
          claimedAt: now,
          expiration: Math.floor(now / 1000) + RECORD_TTL_SECONDS,
        },
        // New event, OR a claim left behind by an attempt that crashed
        ConditionExpression:
          'attribute_not_exists(eventId) OR (#state = :inProgress AND claimedAt < :staleBefore)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':inProgress': 'IN_PROGRESS', ':staleBefore': now - STALE_CLAIM_MS },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

async function getRecord(recordId: string): Promise<Record<string, unknown> | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: PROCESSED_EVENTS_TABLE, Key: { eventId: recordId }, ConsistentRead: true }),
  );
  return Item;
}

async function markDone(recordId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: PROCESSED_EVENTS_TABLE,
      Key: { eventId: recordId },
      UpdateExpression: 'SET #state = :done, doneAt = :now',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':done': 'DONE', ':now': new Date().toISOString() },
    }),
  );
}

function sendNotification(detail: TransferSettled): void {
  // Stand-in for an email/SMS provider. A real call would pass detail.eventId as its idempotency key.
  const amount = `${(Number(detail.amountCents) / 100).toFixed(2)} ${detail.currency}`;
  const message =
    detail.status === 'COMPLETED'
      ? `You sent ${amount} to ${detail.toAccountId}.`
      : `Your transfer of ${amount} to ${detail.toAccountId} was declined.`;
  log('info', { notification: { to: detail.ownerId, idempotencyKey: detail.eventId, message } });
}

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