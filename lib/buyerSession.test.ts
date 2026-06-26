import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { mintBuyerSessionToken } from './buyerSession';

// signJwt reads process.env.JWT_SECRET at module load — run with JWT_SECRET set
// in the command env (the npm test script / npx call sets it).
const SECRET = process.env.JWT_SECRET || 'test-secret-buyersession';

test('mintBuyerSessionToken signs a member-session JWT with the buyer claims', () => {
  const token = mintBuyerSessionToken({
    consumerId: 'recABC',
    email: 'Buyer@Example.com',
    name: 'Jane Buyer',
    state: 'NE',
  });
  const decoded = jwt.verify(token, SECRET) as any;
  assert.equal(decoded.type, 'member-session');
  assert.equal(decoded.consumerId, 'recABC');
  assert.equal(decoded.email, 'buyer@example.com'); // lowercased
  assert.equal(decoded.name, 'Jane Buyer');
  assert.equal(decoded.state, 'NE');
});

test('mintBuyerSessionToken tolerates missing name/state', () => {
  const token = mintBuyerSessionToken({ consumerId: 'recX', email: 'a@b.co' });
  const decoded = jwt.verify(token, SECRET) as any;
  assert.equal(decoded.name, '');
  assert.equal(decoded.state, '');
});
