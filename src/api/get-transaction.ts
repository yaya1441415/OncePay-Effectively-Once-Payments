import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const ID_PATTERN = /^[0-9a-f]{64}$/;


export async function handler(event:APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    try{
        return await getTransaction(event)
    }catch(error) {
        console.error(JSON.stringify({ level: 'ERROR', msg: 'unhandled', error: String(error) }));
        return reply(500, { message: 'Internal error' });
    }
}

async function getTransaction(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (typeof userId!=='string' || !userId) return reply(401, { message: 'Unauthorized' });
    
    const transactionId = event.pathParameters?.id
    if (!transactionId || !ID_PATTERN.test(transactionId)) return reply(400, { message: 'Invalid transaction id' });

    
    const res = await ddb.send(new GetCommand({
        TableName: TRANSACTIONS_TABLE,
        Key: { transactionId: transactionId },
        ConsistentRead: true,
    }));
    const item = res?.Item;
    
    // Same answer for "doesn't exist" and "not yours", so nothing leaks
    if (!item || item.ownerId !== userId) {
        return reply(404, { message: 'Transaction not found' });
    }
    const result  =  {
        transactionId: item!.transactionId,
        status: item!.status, 
        fromAccountId: item!.fromAccountId,
        toAccountId: item!.toAccountId, 
        amountCents: item!.amountCents, 
        currency: item!.currency, 
        createdAt: item!.createdAt,
    }

    return reply(200, result)

    
}   


function reply(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}