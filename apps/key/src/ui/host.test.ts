import { describe, expect, it, vi } from 'vitest';
import { ConstrainedUiHost, validateUiPackage } from './host';

const packageSource = {
  id: 'org.key.example',
  initialState: { enabled: false, selected: 'summary' },
  contributions: [
    {
      id: 'org.key.example.panel',
      slot: 'side_panel' as const,
      root: {
        id: 'root',
        kind: 'column' as const,
        children: [
          {
            id: 'toggle',
            kind: 'toggle' as const,
            label: 'Enabled',
            value: 'enabled',
            command: 'org.key.example/toggle',
          },
        ],
      },
    },
  ],
};

describe('constrained UI host', () => {
  it('keeps command callbacks on the trusted host side', () => {
    const host = new ConstrainedUiHost();
    host.install(packageSource);
    const listener = vi.fn();
    host.subscribe(listener);
    host.registerCommand('org.key.example', 'org.key.example/toggle', command => ({
      enabled: command.payload === true,
    }));

    host.dispatch('org.key.example', {
      id: 'org.key.example/toggle',
      payload: true,
    });

    expect(host.state('org.key.example').enabled).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects duplicate node identities and unbounded trees', () => {
    expect(() =>
      validateUiPackage({
        ...packageSource,
        contributions: [
          {
            id: 'bad',
            slot: 'side_panel',
            root: {
              id: 'duplicate',
              kind: 'column',
              children: [
                { id: 'duplicate', kind: 'text', text: 'not allowed' },
              ],
            },
          },
        ],
      }),
    ).toThrow(/duplicate node id/);

    expect(() =>
      validateUiPackage(packageSource, {
        maximumContributions: 1,
        maximumNodesPerContribution: 1,
        maximumDepth: 1,
        maximumChildrenPerNode: 1,
        maximumStateEntries: 2,
        maximumTextBytes: 1_024,
      }),
    ).toThrow(/node limit/);
  });

  it('uninstalls all package-owned UI and state together', () => {
    const host = new ConstrainedUiHost();
    host.install(packageSource);
    expect(host.contributions('side_panel')).toHaveLength(1);
    host.uninstall(packageSource.id);
    expect(host.contributions()).toHaveLength(0);
    expect(() => host.state(packageSource.id)).toThrow(/unknown UI package/);
  });
});
