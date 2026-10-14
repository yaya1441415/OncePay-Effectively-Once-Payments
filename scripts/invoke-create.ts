import type { APIGatewayProxyEvent } from 'aws-lambda';



async function main() {
    const [transactionsTable, accountsTable, sub] = process.argv.slice(2);
    if (!transactionsTable || !accountsTable || !sub) {
        console.error('Usage: npx tsx scripts/invoke-create.ts <TransactionsTable> <AccountsTable> <sub>');
        process.exit(1);
    }

        process.env.TRANSACTIONS_TABLE = transactionsTable;
        process.env.ACCOUNTS_TABLE = accountsTable;
        process.env.AWS_REGION = 'ca-central-1';

        const {handler} = await import('../src/api/create-transaction')

        const prefix = sub.slice(0, 8);
        const mine = `acc-${prefix}-checking`;
        const myOther = `acc-${prefix}-savings`;
        const key = `test-${Date.now()}`;

        const call = async (label: string, idempotencyKey: string, body: object) => {
            const event = {
                headers: {'Idempotency-Key': idempotencyKey},
                body: JSON.stringify(body),
                requestContext: {authorizer: { claims: { sub }}},
            } as unknown as APIGatewayProxyEvent;
            const res = await handler(event)
            console.log(`\n${label}\n  ${res.statusCode} ${res.body}  ${JSON.stringify(res.headers)}`)

        }
    await call('1. New transfer', key, { fromAccountId: mine, toAccountId: myOther, amountCents: 2500 });
    await call('2. Same key, same body (a retry)', key, { fromAccountId: mine, toAccountId: myOther, amountCents: 2500 });
    await call('3. Same key, different amount', key, { fromAccountId: mine, toAccountId: myOther, amountCents: 9999 });
    await call('4. Sending from someone else\'s account', `${key}-b`, { fromAccountId: 'acc-checking', toAccountId: mine, amountCents: 100 });
    await call('5. Amount with decimals', `${key}-c`, { fromAccountId: mine, toAccountId: myOther, amountCents: 25.5 });
}

main()