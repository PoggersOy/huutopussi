/** Socket-layer pure helpers: reconnect backoff + session persistence keys. */
import { beforeEach, describe, expect, it } from 'vitest';
import { backoffDelay, loadSessionToken, sessionKey } from '../src/socket';

describe('backoffDelay', () => {
  it('doubles from 250ms and caps at 5s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });
});

describe('session token persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keys are per room code, case-normalized', () => {
    expect(sessionKey('abcde')).toBe('hp:session:ABCDE');
    expect(sessionKey('ABCDE')).toBe(sessionKey('abcde'));
  });

  it('loads what was stored for the room', () => {
    localStorage.setItem(sessionKey('QWXYZ'), 'token-1');
    expect(loadSessionToken('qwxyz')).toBe('token-1');
    expect(loadSessionToken('OTHER')).toBeNull();
  });
});
