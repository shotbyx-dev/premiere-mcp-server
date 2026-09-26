import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifier, extractBearerToken, tokensEqual } from '../auth.js';

describe('bearer auth', () => {
  it('accepts the correct token', async () => {
    const verifier = buildVerifier('correct-token-1234567890');
    const info = await verifier.verifyAccessToken('correct-token-1234567890');
    assert.equal(info.clientId, 'premiere-mcp-client');
    assert.ok((info.expiresAt ?? 0) > Math.floor(Date.now() / 1000));
    assert.deepEqual(info.scopes, ['mcp']);
  });

  it('rejects a wrong token with an OAuth error', async () => {
    const verifier = buildVerifier('correct-token-1234567890');
    await assert.rejects(() => verifier.verifyAccessToken('wrong-token'), /Invalid bearer token/);
  });

  it('rejects an empty token', async () => {
    const verifier = buildVerifier('correct-token-1234567890');
    await assert.rejects(() => verifier.verifyAccessToken(''), /Invalid bearer token/);
  });

  it('tokensEqual is length-safe and constant-time', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('abc', 'abcd'), false); // different lengths, no throw
    assert.equal(tokensEqual('', ''), true);
  });

  it('extractBearerToken parses the Authorization header', () => {
    assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
    assert.equal(extractBearerToken('bearer abc123'), 'abc123');
    assert.equal(extractBearerToken('Basic abc123'), null);
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken('Bearer '), null);
  });
});
