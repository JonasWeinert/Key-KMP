import type {
  DataValue,
  StateMap,
  UiCommand,
  UiContribution,
  UiNode,
} from './declarative';

export interface UiHostLimits {
  maximumContributions: number;
  maximumNodesPerContribution: number;
  maximumDepth: number;
  maximumChildrenPerNode: number;
  maximumStateEntries: number;
  maximumTextBytes: number;
}

export const DEFAULT_UI_HOST_LIMITS: UiHostLimits = {
  maximumContributions: 64,
  maximumNodesPerContribution: 512,
  maximumDepth: 24,
  maximumChildrenPerNode: 128,
  maximumStateEntries: 256,
  maximumTextBytes: 64 * 1024,
};

export interface UiPackage {
  id: string;
  contributions: UiContribution[];
  initialState?: Record<string, DataValue>;
}

export type UiCommandHandler = (
  command: UiCommand,
  state: StateMap,
) => void | Record<string, DataValue>;

interface InstalledPackage {
  source: UiPackage;
  state: Record<string, DataValue>;
  handlers: Map<string, UiCommandHandler>;
}

const textEncoder = new TextEncoder();

function byteLength(value: string) {
  return textEncoder.encode(value).byteLength;
}

function nodeStrings(node: UiNode) {
  switch (node.kind) {
    case 'text':
      return [node.text];
    case 'styled_text':
      return node.spans.map(span => span.text);
    case 'metric':
      return [node.label, node.value];
    case 'markdown':
      return [node.markdown];
    case 'button':
      return [node.label, node.command];
    case 'icon_button':
      return [node.icon, node.label, node.command];
    case 'toggle':
      return [node.label, node.value, node.command];
    case 'select':
      return [
        node.label,
        node.value,
        node.command,
        ...node.options.flatMap(option => [option.label, String(option.value ?? '')]),
      ];
    case 'text_field':
      return [node.label, node.value, node.command];
    case 'tabs':
      return [
        node.selected,
        node.command,
        ...node.tabs.flatMap(tab => [tab.id, tab.label]),
      ];
    case 'badge':
      return [node.label];
    case 'progress':
      return [node.label];
    default:
      return [];
  }
}

function childNodes(node: UiNode): UiNode[] {
  if (
    node.kind === 'column' ||
    node.kind === 'row' ||
    node.kind === 'stack' ||
    node.kind === 'list'
  ) {
    return node.children;
  }
  if (node.kind === 'tabs') return node.tabs.map(tab => tab.content);
  return [];
}

function validateState(
  state: Record<string, DataValue>,
  limits: UiHostLimits,
  packageId: string,
) {
  const entries = Object.entries(state);
  if (entries.length > limits.maximumStateEntries) {
    throw new Error(`${packageId} exceeds the state-entry limit`);
  }
  const bytes = entries.reduce(
    (total, [key, value]) => total + byteLength(key) + byteLength(String(value ?? '')),
    0,
  );
  if (bytes > limits.maximumTextBytes) {
    throw new Error(`${packageId} exceeds the state-text limit`);
  }
}

export function validateUiPackage(
  source: UiPackage,
  limits: UiHostLimits = DEFAULT_UI_HOST_LIMITS,
) {
  if (!source.id.trim()) throw new Error('UI package id cannot be empty');
  if (source.contributions.length > limits.maximumContributions) {
    throw new Error(`${source.id} exceeds the contribution limit`);
  }
  validateState(source.initialState ?? {}, limits, source.id);

  const contributionIds = new Set<string>();
  for (const contribution of source.contributions) {
    if (!contribution.id.trim()) throw new Error('contribution id cannot be empty');
    if (contributionIds.has(contribution.id)) {
      throw new Error(`duplicate contribution id ${contribution.id}`);
    }
    contributionIds.add(contribution.id);

    const nodeIds = new Set<string>();
    let nodes = 0;
    let textBytes = 0;
    const stack: Array<{ node: UiNode; depth: number }> = [
      { node: contribution.root, depth: 1 },
    ];
    while (stack.length) {
      const current = stack.pop()!;
      nodes += 1;
      if (nodes > limits.maximumNodesPerContribution) {
        throw new Error(`${contribution.id} exceeds the node limit`);
      }
      if (current.depth > limits.maximumDepth) {
        throw new Error(`${contribution.id} exceeds the tree-depth limit`);
      }
      if (!current.node.id.trim()) throw new Error('UI node id cannot be empty');
      if (nodeIds.has(current.node.id)) {
        throw new Error(`duplicate node id ${current.node.id}`);
      }
      nodeIds.add(current.node.id);
      textBytes += byteLength(current.node.id);
      for (const value of nodeStrings(current.node)) textBytes += byteLength(value);
      if (textBytes > limits.maximumTextBytes) {
        throw new Error(`${contribution.id} exceeds the UI-text limit`);
      }
      if (
        current.node.kind === 'text_field' &&
        (current.node.maximum_bytes < 0 ||
          current.node.maximum_bytes > limits.maximumTextBytes)
      ) {
        throw new Error(`${current.node.id} has an invalid text-field limit`);
      }
      if (
        current.node.kind === 'progress' &&
        (current.node.basis_points < 0 || current.node.basis_points > 10_000)
      ) {
        throw new Error(`${current.node.id} has invalid progress`);
      }
      const children = childNodes(current.node);
      if (children.length > limits.maximumChildrenPerNode) {
        throw new Error(`${current.node.id} exceeds the child limit`);
      }
      for (const child of children) {
        stack.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
}

/**
 * Renderer-neutral owner for constrained UI packages. Packages provide semantic
 * data and command identifiers only; React callbacks and browser handles stay
 * on this trusted side of the boundary.
 */
export class ConstrainedUiHost {
  private readonly installed = new Map<string, InstalledPackage>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limits = DEFAULT_UI_HOST_LIMITS) {}

  install(source: UiPackage) {
    validateUiPackage(source, this.limits);
    this.installed.set(source.id, {
      source,
      state: { ...(source.initialState ?? {}) },
      handlers: new Map(),
    });
    this.publish();
  }

  uninstall(packageId: string) {
    if (this.installed.delete(packageId)) this.publish();
  }

  registerCommand(
    packageId: string,
    commandId: string,
    handler: UiCommandHandler,
  ) {
    const installed = this.requirePackage(packageId);
    installed.handlers.set(commandId, handler);
    return () => installed.handlers.delete(commandId);
  }

  dispatch(packageId: string, command: UiCommand) {
    const installed = this.requirePackage(packageId);
    const patch = installed.handlers.get(command.id)?.(
      Object.freeze({ ...command }),
      Object.freeze({ ...installed.state }),
    );
    if (patch) this.patchState(packageId, patch);
  }

  patchState(packageId: string, patch: Record<string, DataValue>) {
    const installed = this.requirePackage(packageId);
    const next = { ...installed.state, ...patch };
    validateState(next, this.limits, packageId);
    installed.state = next;
    this.publish();
  }

  state(packageId: string): StateMap {
    return Object.freeze({ ...this.requirePackage(packageId).state });
  }

  contributions(slot?: UiContribution['slot']) {
    return [...this.installed.entries()]
      .flatMap(([packageId, installed]) =>
        installed.source.contributions.map(contribution => ({
          packageId,
          contribution,
        })),
      )
      .filter(entry => !slot || entry.contribution.slot === slot)
      .sort(
        (left, right) =>
          (left.contribution.priority ?? 0) -
            (right.contribution.priority ?? 0) ||
          left.contribution.id.localeCompare(right.contribution.id),
      );
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requirePackage(packageId: string) {
    const installed = this.installed.get(packageId);
    if (!installed) throw new Error(`unknown UI package ${packageId}`);
    return installed;
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
