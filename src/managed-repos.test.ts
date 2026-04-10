import { describe, it, expect } from 'vitest';
import { isManagedRepo, MANAGED_REPOS } from './managed-repos.js';

describe('MANAGED_REPOS', () => {
  it('contains cliftonc/drizzle-cube', () => {
    expect(MANAGED_REPOS).toContain('cliftonc/drizzle-cube');
  });

  it('contains cliftonc/drizby', () => {
    expect(MANAGED_REPOS).toContain('cliftonc/drizby');
  });

  it('contains cliftonc/lastlight', () => {
    expect(MANAGED_REPOS).toContain('cliftonc/lastlight');
  });
});

describe('isManagedRepo', () => {
  it('returns true for a managed repo', () => {
    expect(isManagedRepo('cliftonc/drizzle-cube')).toBe(true);
  });

  it('returns true for another managed repo', () => {
    expect(isManagedRepo('cliftonc/drizby')).toBe(true);
  });

  it('returns false for an unknown repo', () => {
    expect(isManagedRepo('unknown/repo')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isManagedRepo(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isManagedRepo(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isManagedRepo('')).toBe(false);
  });
});
