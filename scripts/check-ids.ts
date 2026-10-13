import { transactionIdFor, openShardFor, payloadHashFor } from '../src/shared/ids';

const a = transactionIdFor('user-1', 'key-1');
const b = transactionIdFor('user-1', 'key-1');
const c = transactionIdFor('user-2', 'key-1');
const d = transactionIdFor('ab', 'c');
const e = transactionIdFor('a', 'bc');


console.log('same user + key gives same ID:   ', a === b);
console.log('different user gives different ID:', a !== c);
console.log('separator prevents collisions:    ', d !== e);
console.log('shard of a:', openShardFor(a));
console.log('same payload, same hash:          ',
  payloadHashFor('x', 'y', 500) === payloadHashFor('x', 'y', 500));
console.log('different amount, different hash: ',
  payloadHashFor('x', 'y', 500) !== payloadHashFor('x', 'y', 501));