import { describe, it, expect, afterEach } from 'vitest';
import { isManagedRepo, getManagedRepos, DEFAULT_MANAGED_REPOS } from './managed-repos.js';
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from './config.js';

function configWithRepos(repos: string[]): LastLightConfig {
  return { managedRepos: repos } as unknown as LastLightConfig;
}

describe('DEFAULT_MANAGED_REPOS', () => {
  it('is empty so no deployment-specific repos are baked into the source', () => {
    expect(DEFAULT_MANAGED_REPOS).toEqual([]);
  });
});

describe('getManagedRepos / isManagedRepo', () => {
  afterEach(() => resetRuntimeConfigForTests());

  it('reflects the repos in the loaded runtime config', () => {
    setRuntimeConfig(configWithRepos(['acme/one', 'acme/two']));
    expect(getManagedRepos()).toEqual(['acme/one', 'acme/two']);
    expect(isManagedRepo('acme/one')).toBe(true);
    expect(isManagedRepo('acme/two')).toBe(true);
  });

  it('returns false for an unmanaged repo', () => {
    setRuntimeConfig(configWithRepos(['acme/one']));
    expect(isManagedRepo('unknown/repo')).toBe(false);
  });

  it('falls back to the (empty) default when no runtime config is loaded', () => {
    resetRuntimeConfigForTests();
    expect(getManagedRepos()).toEqual([]);
    expect(isManagedRepo('acme/one')).toBe(false);
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
