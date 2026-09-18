import { describe, expect, it } from 'vitest';

import { describeDevice } from './security';

/**
 * The session list is where a person notices a device they do not recognise, so
 * these assertions are about a security control rather than about formatting.
 */
describe('describeDevice', () => {
  it('names a real Chrome-on-macOS agent', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
  });

  it('calls Safari on an iPhone what its owner calls it', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
  });

  /**
   * Every Chrome user-agent also contains the token `Safari`. Testing Safari
   * first would label every Chrome session "Safari on macOS" — and a session
   * list that misnames the browser is worse than one that says nothing, because
   * it invites someone to dismiss a session that IS theirs or accept one that
   * is not.
   */
  it('does not call Chrome "Safari" even though its agent says Safari', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    expect(chrome).toContain('Safari');
    expect(describeDevice(chrome)).toBe('Chrome on Windows');
  });

  it('prefers Edge over the Chrome token it also carries', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      ),
    ).toBe('Edge on Windows');
  });

  it('says it does not know rather than guessing', () => {
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('curl/8.4.0')).toBe('Unknown device');
  });

  it('falls back to whichever half it could read', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
  });
});
