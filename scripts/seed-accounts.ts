import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';


const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ca-central-1' }));


const SYSTEM_ACCOUNT = 'sys-opening-balances';



//makes the seed re-runnable for any test user. 
function accountsFor(ownerId: string){
    const prefix = ownerId.slice(0, 8);
    return [
        { accountId: `acc-${prefix}-checking`, openingCents: 100000 }, // $1,000.00
        { accountId: `acc-${prefix}-savings`, openingCents: 50000 },   // $500.00
    ]
}

async function  seedAccount(
    accountsTable: string,
    ledgerTable: string, 
    ownerId: string,
    accountId: string,
    amount: number,
) {
    const transactionId = `opening-${accountId}`;
    const now = new Date().toISOString();

    await ddb.send(new TransactWriteCommand({
        TransactItems: [
            // 1. Create the customer account, only if it doesn't exist yet
            {
                Put : {
                    TableName: accountsTable,
                    Item: { accountId, ownerId, accountType: 'customer', currency: 'CAD', balanceCents: amount, createdAt: now },
                    ConditionExpression: 'attribute_not_exists(accountId)',
                },
            },
            // 2. Take the same amount from the system account (created on first use, no ownerId)
            {
                Update: {
                    TableName: accountsTable,
                    Key: { accountId: SYSTEM_ACCOUNT },
                    UpdateExpression:
                        'SET balanceCents = if_not_exists(balanceCents, :zero) - :amount, accountType = :system, currency = :cad',
                    ExpressionAttributeValues: {':zero': 0, ':amount': amount, ':system': 'system', ':cad': 'CAD' },
                }
            },
            // 3. Ledger: debit the system account
            {
                Put: {
                    TableName: ledgerTable,
                    Item: { transactionId, entryId: `DEBIT#${SYSTEM_ACCOUNT}`, accountId: SYSTEM_ACCOUNT, amountCents: -amount, postedAt: now },
                    ConditionExpression: 'attribute_not_exists(transactionId)',
                },
            },
            // 4. Ledger: credit the cutsomer account 
            {
                Put: {
                    TableName: ledgerTable,
                    Item: { transactionId, entryId: `CREDIT#${accountId}`, accountId, amountCents: amount, postedAt: now },
                    ConditionExpression: 'attribute_not_exists(transactionId)',
                },
            },
        ],        
    }));
}

async function main() {
    const [accountsTable, ledgerTable, ownerId] = process.argv.slice(2);
    if (!accountsTable || !ledgerTable || !ownerId) {
        console.error('Usage: npx tsx scripts/seed-accounts.ts <AccountsTable> <LedgerTable> <ownerId>');
        process.exit(1);
    }

    for (const {accountId, openingCents } of accountsFor(ownerId)) {
        try {
            await seedAccount(accountsTable, ledgerTable, ownerId, accountId, openingCents);
            console.log(`Created ${accountId} with ${openingCents} cents`);
        } catch(error) {
            const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
            if((error as Error).name === 'TransactionCanceledException' && reasons?.[0]?.Code === 'ConditionalCheckFailed') {
                console.log(`${accountId} already exists, skipped (nothing was written)`);
            }else {
                throw error;
            }
        }
    }
}

main()



