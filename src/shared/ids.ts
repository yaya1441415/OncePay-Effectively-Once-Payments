import { createHash } from 'node:crypto';

const SEPARATOR = '\u0000';// a character that can't appear in a user ID or key

//fingerprints your sub+key
export function transactionIdFor(userId: string, idempotencyKey: string): string {
    return createHash('sha256')
        .update(`${userId}${SEPARATOR}${idempotencyKey}`)
        .digest('hex')
}

export function openShardFor(transactionId: string): string {
    const n = parseInt(transactionId.slice(0, 8), 16);
    return `OPEN#${n % 10}`;
}


export function payloadHashFor(fromAccountId: string, toAccountId: string, amountCents: number): string {
    return createHash('sha256')
        .update(JSON.stringify([fromAccountId, toAccountId, amountCents]))
        .digest('hex')
}