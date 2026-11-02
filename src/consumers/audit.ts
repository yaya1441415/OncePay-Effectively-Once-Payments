import type { EventBridgeEvent } from 'aws-lambda';
import { S3Client, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';



const s3 = new S3Client({})
const AUDIT_BUCKET = requireEnv('AUDIT_BUCKET')

const ID_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const STATUSES = ['COMPLETED', 'FAILED'];


interface TransferSettled {
  eventId: string;
  transactionId: string;
  status: string;
  ownerId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: string; // DynamoDB streams carry numbers as strings
  currency: string;
  settledAt: string;
}


export const handler = async (
    event: EventBridgeEvent<'TransferSettled', TransferSettled>,
): Promise<void> => {
    const detail = event.detail;
    if(
        !ID_PATTERN.test(detail.transactionId) ||
        !STATUSES.includes(detail.status) ||
        !DATE_PATTERN.test(detail.settledAt)
    ) {
        throw  namedError('InvalidEvent');
    }

    const key = `audit/${detail.settledAt.slice(0, 10)}/${detail.transactionId}-${detail.status}.json`;

    const record = {
        eventId: detail.eventId,
        eventBridgeId: event.id,
        source: event.source,
        detailType: event['detail-type'],
        publishedAt: event.time,
        recordedAt: new Date().toISOString(),
        transfer: { ...detail, amountCents: Number(detail.amountCents) },
    };

    try{
        await s3.send(
            new PutObjectCommand({
                Bucket: AUDIT_BUCKET,
                Key: key,
                Body: JSON.stringify(record),
                ContentType: 'application/json',
                IfNoneMatch: '*',          // only create; never add a second version
                ChecksumAlgorithm: 'SHA256', // Object Lock buckets require an integrity checksum
            }),
        );
        log('info', { eventId: detail.eventId, outcome: 'RECORDED', key })
    } catch(error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
            log('info', { eventId: detail.eventId, outcome: 'ALREADY_RECORDED', key });
            return;
        }
        throw error;
    }
}


// HELPERS
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