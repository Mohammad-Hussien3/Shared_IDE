import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { CollaborativeCursors } from './cursors';
let doc, remote, awareness, remoteAwareness, editor, cursors, model, presence;
const color = '#68dcaa';
const monaco = { Range: class { constructor(...points) { this.points = points; } },
  editor: { ContentWidgetPositionPreference: { EXACT: 0 }, TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 } } };
const select = (start, end) => {
  remoteAwareness.setLocalStateField('selection', {
    anchor: Y.createRelativePositionFromTypeIndex(remote.getText('content'), start),
    head: Y.createRelativePositionFromTypeIndex(remote.getText('content'), end),
  });
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remoteAwareness, [remote.clientID]), 'server'); cursors.render();
};
beforeEach(() => {
  doc = new Y.Doc(); doc.getText('content').insert(0, 'hello');
  remote = new Y.Doc(); Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  awareness = new Awareness(doc); remoteAwareness = new Awareness(remote);
  awareness.setLocalStateField('user', { id: 1, username: 'Owner', color: '#b59aff' });
  remoteAwareness.setLocalStateField('user', { id: 2, username: 'Sara', color });
  model = { getOffsetAt: p => p.column - 1, getPositionAt: i => ({ lineNumber: 1, column: i + 1 }), isDisposed: () => false };
  editor = { getModel: () => model, getSelection: () => ({ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 1 }),
    onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })), onDidBlurEditorText: vi.fn(() => ({ dispose: vi.fn() })),
    addContentWidget: vi.fn(w => document.body.append(w.node)), removeContentWidget: vi.fn(), layoutContentWidget: vi.fn(),
    deltaDecorations: vi.fn(() => ['selection']) };
  presence = vi.fn(); cursors = new CollaborativeCursors({ doc, text: doc.getText('content'), awareness }, editor, monaco, presence);
});
afterEach(() => { cursors.destroy(); awareness.destroy(); remoteAwareness.destroy(); doc.destroy(); remote.destroy(); });
it('renders remote caret and translucent selection using relative coordinates', () => {
  select(1, 4);
  const widget = [...cursors.items.values()][0]; expect(widget.position).toEqual({ lineNumber: 1, column: 5 });
  expect(widget.node.style.getPropertyValue('--collaborator-color')).toBe(color);
  expect(editor.deltaDecorations.mock.lastCall[1][0].range.points).toEqual([1, 2, 1, 5]);
  expect(widget.style.textContent).toContain(`${color} 25%`);
  expect(cursors.items.size).toBe(1); // no duplicate local caret
  expect(presence.mock.lastCall[0].map(p => p.username)).toEqual(['Owner', 'Sara']);
});
it('shows the authenticated username on hover, touch click and keyboard focus', () => {
  select(0, 0); const widget = [...cursors.items.values()][0];
  expect(widget.label.hidden).toBe(true); expect(widget.label.textContent).toBe('Sara');
  for (const event of ['mouseenter', 'click', 'focus']) {
    widget.node.dispatchEvent(new Event(event)); expect(widget.label.hidden).toBe(false);
    widget.node.dispatchEvent(new Event('blur')); expect(widget.label.hidden).toBe(true);
  }
  const touch = new Event('pointerup'); Object.defineProperty(touch, 'pointerType', { value:'touch' });
  widget.node.dispatchEvent(touch);
  widget.node.dispatchEvent(new Event('mouseleave'));
  expect(widget.label.hidden).toBe(false); // touch-generated pointer leave must not hide a tapped label
  document.body.dispatchEvent(new Event('pointerdown', { bubbles:true }));
  expect(widget.label.hidden).toBe(true);
  expect(widget.node.getAttribute('aria-label')).toBe("Sara's cursor");
});
it('keeps remote selections aligned when another user inserts text before them', () => {
  select(1, 4); doc.getText('content').insert(0, 'new'); cursors.render();
  const widget = [...cursors.items.values()][0]; expect(widget.position.column).toBe(8);
  expect(editor.deltaDecorations.mock.lastCall[1][0].range.points).toEqual([1, 5, 1, 8]);
});
it('removes disconnected cursors and selections', () => {
  select(1, 4); remoteAwareness.setLocalState(null);
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remoteAwareness, [remote.clientID]), 'server'); cursors.render();
  expect(cursors.items.size).toBe(0); expect(editor.removeContentWidget).toHaveBeenCalledOnce();
  expect(editor.deltaDecorations.mock.lastCall[1]).toEqual([]); expect(presence.mock.lastCall[0]).toHaveLength(1);
});
it('deduplicates one user in several tabs in the presence header, while showing each remote caret', () => {
  select(1, 4); const other = new Y.Doc(), a = new Awareness(other);
  a.setLocalState(remoteAwareness.getLocalState()); applyAwarenessUpdate(awareness, encodeAwarenessUpdate(a, [other.clientID]), 'server'); cursors.render();
  expect(cursors.items.size).toBe(2); expect(presence.mock.lastCall[0]).toHaveLength(2);
  expect([...cursors.items.values()].map(item=>item.node.style.getPropertyValue('--caret-offset')).sort()).toEqual(['0px','10px']);
  a.destroy(); other.destroy();
});
it('disposes editor subscriptions, widgets, styles and document listeners', () => {
  select(1, 4); const widget = [...cursors.items.values()][0]; cursors.destroy();
  expect(widget.node.isConnected).toBe(false); expect(widget.style.isConnected).toBe(false);
  expect(editor.onDidChangeCursorSelection.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  expect(editor.onDidBlurEditorText.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  expect(awareness.getLocalState().selection).toBeNull(); expect(presence.mock.lastCall[0]).toEqual([]);
  cursors.destroy = () => {}; // avoid double disposal in fixture cleanup
});
