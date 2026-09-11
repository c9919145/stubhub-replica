'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, CUSTOMER_EMAIL } = require('./helpers');

test('register creates an account, sets a session, and returns public user', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const res = await app.app.post('/api/auth/register')
    .send({ email: 'new@user.dev', password: 'supersecret1', name: 'New User' });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'new@user.dev');
  assert.equal(res.body.user.name, 'New User');
  assert.equal(res.body.user.isAdmin, false);
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith('sid=')));
  assert.equal(res.body.user.password_hash, undefined);

  const me = await app.app.get('/api/auth/me').set('Cookie', cookie(res));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'new@user.dev');
});

test('rejects invalid emails, weak passwords, and duplicate accounts', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.post('/api/auth/register').send({ email: 'not-an-email', password: 'supersecret1' })).status, 400);
  assert.equal((await app.app.post('/api/auth/register').send({ email: 'a@b.dev', password: 'short' })).status, 400);
  const first = await app.app.post('/api/auth/register').send({ email: 'dupe@user.dev', password: 'supersecret1', name: 'Dup User' });
  assert.equal(first.status, 201);
  const dup = await app.app.post('/api/auth/register').send({ email: 'DUPE@user.dev', password: 'supersecret1', name: 'Dup User' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'EMAIL_TAKEN');
});

test('login success and failure', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.post('/api/auth/login').send({ email: CUSTOMER_EMAIL, password: 'wrong' })).status, 401);
  const ok = await app.app.post('/api/auth/login').send({ email: CUSTOMER_EMAIL, password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, CUSTOMER_EMAIL);
  assert.ok(ok.headers['set-cookie']);
});

test('GET /api/auth/me requires authentication; logout destroys the session', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.get('/api/auth/me')).status, 401);

  const login = await loginHelper(app);
  const before = await app.app.get('/api/auth/me').set('Cookie', login);
  assert.equal(before.status, 200);

  await app.app.post('/api/auth/logout').set('Cookie', login);
  const after = await app.app.get('/api/auth/me').set('Cookie', login);
  assert.equal(after.status, 401);
});

function cookie(res) {
  const setCookie = res.headers['set-cookie'][0];
  return setCookie.split(';')[0];
}

async function loginHelper(app) {
  const res = await app.app.post('/api/auth/login').send({ email: CUSTOMER_EMAIL, password: 'password123' });
  return cookie(res);
}