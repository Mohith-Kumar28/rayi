import { describe, expect, it } from 'vitest';

import {
  CHECK_CATALOGUE,
  UnknownCheckError,
  checkDefinition,
  checkLabel,
  checkTier,
  isCheckName,
} from './catalogue.js';

describe('the check catalogue', () => {
  it('has a unique name per check', () => {
    const names = CHECK_CATALOGUE.map((check) => check.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The label is what a reviewer reads while deciding whether to pay someone.
   * A label equal to the registry key means the key reached a screen.
   */
  it('never labels a check with its own registry key', () => {
    for (const check of CHECK_CATALOGUE) {
      expect(check.label).not.toBe(check.name);
      expect(check.label).not.toMatch(/_/);
      // A sentence a person reads starts like one.
      expect(check.label[0]).toBe(check.label[0]?.toUpperCase());
    }
  });

  it('resolves a known check', () => {
    expect(checkLabel('disclosure')).toBe('Paid partnership disclosure');
    expect(checkTier('disclosure')).toBe('BLOCKING');
  });

  /**
   * `duplicate` is ADVISORY on purpose — a near-identical clip is often a
   * legitimate series recap. If it ever became BLOCKING it would start bouncing
   * that work back to creators before a human saw it, so the tier is asserted
   * rather than left to whoever edits the list next.
   */
  it('keeps the duplicate check advisory', () => {
    expect(checkTier('duplicate')).toBe('ADVISORY');
  });

  it('throws on an unknown check rather than falling back to the key', () => {
    expect(() => checkDefinition('nope')).toThrow(UnknownCheckError);
    // The name the pipeline emitted has to survive into the error, or the
    // message cannot say which check was wrong.
    expect(() => checkDefinition('nope')).toThrow(/"nope"/);
    try {
      checkDefinition('nope');
      expect.unreachable();
    } catch (error) {
      expect((error as UnknownCheckError).checkName).toBe('nope');
      expect((error as UnknownCheckError).name).toBe('UnknownCheckError');
    }
  });

  it('narrows a known name', () => {
    expect(isCheckName('resolution')).toBe(true);
    expect(isCheckName('resolutionn')).toBe(false);
  });
});
