const test = require('node:test');
const assert = require('node:assert');
const { parseStream, parseInitPage } = require('../src/gemini');

const frame = (text, cid = 'c_1', rid = 'r_1', rcid = 'rc_1') =>
  JSON.stringify([['wrb.fr', null, JSON.stringify([null, [cid, rid], null, null, [[rcid, [text]]]])]]);

test('parseStream picks the last cumulative frame and metadata', () => {
  const f1 = frame('Hel'), f2 = frame('Hello wörld');
  const raw = `)]}'\n\n${f1.length}\n${f1}\n${f2.length}\n${f2}\n`;
  assert.deepStrictEqual(parseStream(raw), { text: 'Hello wörld', meta: ['c_1', 'r_1', 'rc_1'] });
});

test('parseStream tolerates truncated trailing frame', () => {
  const f1 = frame('partial');
  assert.strictEqual(parseStream(`)]}'\n\n${f1}\n123\n[["wrb.fr",null,"[null,[`).text, 'partial');
});

test('parseStream returns null without candidates', () => {
  assert.strictEqual(parseStream(`)]}'\n\n[["e",4,null,null,131]]\n`), null);
});

test('parseInitPage extracts tokens', () => {
  assert.deepStrictEqual(parseInitPage('..."SNlM0e":"AT1","cfb2h":"boq_x","FdrFJe":"-123"...'), { at: 'AT1', bl: 'boq_x', sid: '-123' });
});
