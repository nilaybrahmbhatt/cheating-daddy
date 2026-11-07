const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProfiles, findGeminiCookies, parseCookieHeader, parseIni } = require('../src/firefoxCookies');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffroot-'));
  const mk = (name, rows) => {
    const dir = path.join(root, 'Profiles', name); fs.mkdirSync(dir, { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'cookies.sqlite'));
    db.exec("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, originAttributes TEXT DEFAULT '', lastAccessed INTEGER)");
    const ins = db.prepare('INSERT INTO moz_cookies (name,value,host,originAttributes,lastAccessed) VALUES (?,?,?,?,?)');
    rows.forEach((r) => ins.run(...r));
    db.close();
    return `Profiles/${name}`;
  };
  return { root, mk };
}

test('picks the install-default profile and reads google cookies only', () => {
  const { root, mk } = makeRoot();
  const empty = mk('a.empty', [['x', '1', '.example.com', '', 1]]);
  const good = mk('b.default', [
    ['__Secure-1PSID', 'SID', '.google.com', '', 5],
    ['__Secure-1PSIDTS', 'TS', '.google.com', '', 5],
    ['__Secure-1PSID', 'CONTAINER', '.google.com', '^userContextId=2', 9],
    ['evil', 'no', '.notgoogle.com', '', 1],
  ]);
  fs.writeFileSync(path.join(root, 'profiles.ini'),
    `[Profile0]\nName=a\nIsRelative=1\nPath=${empty}\n\n[Profile1]\nName=b\nIsRelative=1\nPath=${good}\n\n[Install123]\nDefault=${good}\n`);
  assert.strictEqual(listProfiles(root)[0], path.join(root, good));
  const { cookies } = findGeminiCookies({ root });
  assert.strictEqual(cookies['__Secure-1PSID'], 'SID');
  assert.strictEqual(cookies.evil, undefined);
});

test('errors helpfully when not logged in', () => {
  const { root, mk } = makeRoot();
  const p = mk('x.default', [['foo', 'bar', '.google.com', '', 1]]);
  fs.writeFileSync(path.join(root, 'profiles.ini'), `[Profile0]\nIsRelative=1\nPath=${p}\nDefault=1\n`);
  assert.throws(() => findGeminiCookies({ root }), /sign in/i);
});

test('parseCookieHeader / parseIni', () => {
  assert.deepStrictEqual(parseCookieHeader('Cookie: a=b; c=d=e'), { a: 'b', c: 'd=e' });
  assert.strictEqual(parseIni('[A]\nk=v\n').A.k, 'v');
});
