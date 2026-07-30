import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Button, IconButton } from './primitives';

export type DataValue = string | number | boolean | null;
export type StateMap = Readonly<Record<string, DataValue>>;
export type BooleanSource =
  | boolean
  | { binding: string; equals?: DataValue; inverted?: boolean };

interface NodeBase {
  id: string;
  visible?: BooleanSource;
}

export type UiNode =
  | (NodeBase & { kind: 'column' | 'row' | 'stack' | 'list'; children: UiNode[] })
  | (NodeBase & { kind: 'text'; text: string; selectable?: boolean })
  | (NodeBase & {
      kind: 'styled_text';
      spans: Array<{ text: string; emphasis?: 'normal' | 'muted' | 'strong' | 'code' }>;
      selectable?: boolean;
    })
  | (NodeBase & {
      kind: 'metric';
      label: string;
      value: string;
      format?: 'integer' | 'decimal' | 'percentage' | 'bytes';
    })
  | (NodeBase & { kind: 'markdown'; markdown: string; selectable?: boolean })
  | (NodeBase & { kind: 'button'; label: string; command: string; payload?: DataValue })
  | (NodeBase & { kind: 'icon_button'; icon: string; label: string; command: string })
  | (NodeBase & { kind: 'toggle'; label: string; value: string; command: string })
  | (NodeBase & {
      kind: 'select';
      label: string;
      value: string;
      options: Array<{ label: string; value: DataValue }>;
      command: string;
    })
  | (NodeBase & {
      kind: 'text_field';
      label: string;
      value: string;
      command: string;
      maximum_bytes: number;
    })
  | (NodeBase & {
      kind: 'tabs';
      tabs: Array<{ id: string; label: string; content: UiNode }>;
      selected: string;
      command: string;
    })
  | (NodeBase & {
      kind: 'badge';
      label: string;
      tone: 'neutral' | 'accent' | 'positive' | 'caution' | 'critical';
    })
  | (NodeBase & { kind: 'divider' | 'spacer' })
  | (NodeBase & { kind: 'progress'; label: string; basis_points: number });

export interface UiContribution {
  id: string;
  slot:
    | 'command_palette'
    | 'top_toolbar'
    | 'pdf_floating_toolbar'
    | 'selection_context_pill'
    | 'document_overlay'
    | 'hover_card'
    | 'side_panel'
    | 'context_menu'
    | 'status_area'
    | 'settings_panel';
  priority?: number;
  root: UiNode;
}

export interface UiCommand {
  id: string;
  payload?: DataValue;
}

function resolveVisible(source: BooleanSource | undefined, state: StateMap) {
  if (source === undefined) return true;
  if (typeof source === 'boolean') return source;
  const value = state[source.binding];
  const resolved = source.equals === undefined ? Boolean(value) : value === source.equals;
  return source.inverted ? !resolved : resolved;
}

function formatMetric(value: DataValue, format = 'integer') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (format === 'decimal') return value.toFixed(2);
  if (format === 'percentage') return `${value.toFixed(1)}%`;
  if (format === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = Math.max(0, value);
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
  }
  return Math.round(value).toLocaleString();
}

function hostIcon(name: string): IconName {
  const supported: IconName[] = [
    'add', 'close', 'document', 'search', 'sidebar', 'split', 'previous', 'next',
    'zoom_out', 'zoom_in', 'fit_width', 'comments', 'book', 'highlight', 'note',
    'delete', 'more', 'check', 'panel_left',
  ];
  return supported.includes(name as IconName) ? name as IconName : 'document';
}

function markdownBlocks(markdown: string) {
  return markdown.split(/\n{2,}/).map((block, index) => {
    const heading = block.match(/^(#{1,3})\s+(.+)$/s);
    if (heading) {
      const Level = `h${heading[1].length + 2}` as 'h3' | 'h4' | 'h5';
      return <Level key={index}>{heading[2]}</Level>;
    }
    return <p key={index}>{block}</p>;
  });
}

export function DeclarativeView({
  contribution,
  state,
  dispatch,
}: {
  contribution: UiContribution;
  state: StateMap;
  dispatch: (command: UiCommand) => void;
}) {
  const render = (node: UiNode): ReactNode => {
    if (!resolveVisible(node.visible, state)) return null;
    switch (node.kind) {
      case 'column':
      case 'row':
      case 'stack':
      case 'list':
        return (
          <div key={node.id} className={`key-ui-${node.kind}`}>
            {node.children.map(render)}
          </div>
        );
      case 'text':
        return <span key={node.id} className={node.selectable ? 'selectable' : ''}>{node.text}</span>;
      case 'styled_text':
        return (
          <span key={node.id} className={node.selectable ? 'selectable' : ''}>
            {node.spans.map((span, index) => {
              if (span.emphasis === 'strong') return <strong key={index}>{span.text}</strong>;
              if (span.emphasis === 'code') return <code key={index}>{span.text}</code>;
              return <span key={index} className={span.emphasis === 'muted' ? 'muted' : ''}>{span.text}</span>;
            })}
          </span>
        );
      case 'metric':
        return (
          <div key={node.id} className="key-ui-metric">
            <span>{node.label}</span>
            <strong>{formatMetric(state[node.value], node.format)}</strong>
          </div>
        );
      case 'markdown':
        return <div key={node.id} className={`key-ui-markdown ${node.selectable ? 'selectable' : ''}`}>{markdownBlocks(node.markdown)}</div>;
      case 'button':
        return <Button key={node.id} onClick={() => dispatch({ id: node.command, payload: node.payload })}>{node.label}</Button>;
      case 'icon_button':
        return <IconButton key={node.id} icon={hostIcon(node.icon)} label={node.label} onClick={() => dispatch({ id: node.command })} />;
      case 'toggle':
        return (
          <label key={node.id} className="key-ui-toggle">
            <input type="checkbox" checked={state[node.value] === true} onChange={event => dispatch({ id: node.command, payload: event.currentTarget.checked })} />
            <span>{node.label}</span>
          </label>
        );
      case 'select':
        return (
          <label key={node.id} className="key-ui-select">
            <span>{node.label}</span>
            <select
              value={String(state[node.value] ?? '')}
              onChange={event => {
                const option = node.options.find(candidate => String(candidate.value) === event.currentTarget.value);
                dispatch({ id: node.command, payload: option?.value });
              }}
            >
              {node.options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
            </select>
          </label>
        );
      case 'text_field':
        return (
          <label key={node.id} className="key-ui-field">
            <span>{node.label}</span>
            <input
              value={String(state[node.value] ?? '')}
              maxLength={node.maximum_bytes}
              onChange={event => dispatch({ id: node.command, payload: event.currentTarget.value })}
            />
          </label>
        );
      case 'tabs': {
        const selected = String(state[node.selected] ?? node.tabs[0]?.id);
        const active = node.tabs.find(tab => tab.id === selected) ?? node.tabs[0];
        return (
          <div key={node.id} className="key-ui-tabs">
            <div role="tablist">
              {node.tabs.map(tab => (
                <button key={tab.id} type="button" role="tab" aria-selected={tab.id === active?.id} onClick={() => dispatch({ id: node.command, payload: tab.id })}>{tab.label}</button>
              ))}
            </div>
            {active && render(active.content)}
          </div>
        );
      }
      case 'badge':
        return <span key={node.id} className={`key-ui-badge ${node.tone}`}>{node.label}</span>;
      case 'divider':
        return <hr key={node.id} />;
      case 'spacer':
        return <span key={node.id} className="key-ui-spacer" />;
      case 'progress':
        return (
          <label key={node.id} className="key-ui-progress">
            <span>{node.label}</span>
            <progress max={10_000} value={node.basis_points} />
          </label>
        );
    }
  };

  return (
    <div className="key-declarative-view" data-contribution={contribution.id}>
      {render(contribution.root)}
    </div>
  );
}

export function ContributionSlot({
  slot,
  contributions,
  state,
  dispatch,
}: {
  slot: UiContribution['slot'];
  contributions: UiContribution[];
  state: StateMap;
  dispatch: (command: UiCommand) => void;
}) {
  return contributions
    .filter(contribution => contribution.slot === slot)
    .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
    .map(contribution => (
      <DeclarativeView
        key={contribution.id}
        contribution={contribution}
        state={state}
        dispatch={dispatch}
      />
    ));
}
